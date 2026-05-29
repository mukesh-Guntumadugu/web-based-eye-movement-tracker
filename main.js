// ============================================================
// FOCUS TYPING GAME — Auto-Calibrating Eye Tracker
// MediaPipe FaceMesh ML: iris + head + eyelid detection
// ============================================================

// ---------- WORDS ----------
var WORDS = [
    'sky','dog','cat','sun','run','fly','map','box',
    'code','game','star','tree','fast','jump','bird',
    'flow','fish','rock','moon','fire','wind','lake',
    'blue','help','rain','king','dark','gold','leaf',
    'type','gaze','open','book','home','land','play',
    'focus','quick','brain','light','dream','cloud',
    'smile','power','magic','ocean','river','music',
    'happy','green','stone','heart','world','north',
    'speed','tiger','eagle','dance','brave','spark'
];
var COLORS = ['balloon-red','balloon-blue','balloon-green','balloon-orange','balloon-purple','balloon-pink','balloon-teal'];

// ---------- CONFIG ----------
var MAX_LIVES = 5;
var PENALTY_MS = 1800;
var FLOAT_MS = 12000;
var SPAWN_MS = 3000;
var MAX_BUBBLES = 5;
var CAL_MS = 3000;        // auto-calibration duration
var SMOOTH_FRAMES = 8;    // smooth over last N frames

// ---------- STATE ----------
var isDown = false;
var score = 0;
var downs = 0;
var lives = MAX_LIVES;
var penalty = false;
var running = false;
var target = null;
var bubbles = [];
var bid = 0;
var timer = null;
var log = [];
var used = new Set();

// Calibration
var calibrating = true;
var calSamples = [];
var calStart = 0;
// Baselines (set during calibration)
var bIris = 0.5;
var bHead = 0.45;
var bEAR = 0.25;

// Smoothing buffers
var irisBuffer = [];
var headBuffer = [];
var earBuffer = [];

// ---------- DOM ----------
var $start = document.getElementById('screen-start');
var $game = document.getElementById('screen-game');
var $results = document.getElementById('screen-results');
var $bubbles = document.getElementById('bubbles-container');
var $target = document.getElementById('target-word-display');
var $input = document.getElementById('typing-input');
var $gazeInd = document.getElementById('gaze-indicator');
var $gazeIcon = document.getElementById('gaze-icon');
var $gazeTxt = document.getElementById('gaze-text');
var $score = document.getElementById('hud-score');
var $downs = document.getElementById('hud-down-count');
var $lives = document.getElementById('lives-display');
var $penOver = document.getElementById('penalty-overlay');
var $penInfo = document.getElementById('penalty-info');
var $btnStart = document.getElementById('btn-start-game');
var $loading = document.getElementById('loading-msg');
var $btnAgain = document.getElementById('btn-restart');
var $rScore = document.getElementById('res-score');
var $rDown = document.getElementById('res-down');
var $dWords = document.getElementById('down-words-list');
var $logBody = document.getElementById('log-tbody');
var $video = document.getElementById('webcam');
var $calMsg = document.getElementById('calibration-msg');

// ---------- INIT ----------
window.onload = function() {
    $btnStart.addEventListener('click', start);
    $btnAgain.addEventListener('click', function() { location.reload(); });
    $input.addEventListener('input', onType);
    drawLives();
    makeClouds();

    // -- Laptop Accelerometer / Tilt Sensors --
    var $tiltVal = document.getElementById('screen-tilt-val');
    function updateTilt(angle) {
        if ($tiltVal) $tiltVal.textContent = Math.round(angle) + '°';
    }

    // Attempt 1: Modern Generic Sensor API (Accelerometer)
    if ('Accelerometer' in window) {
        try {
            var acc = new Accelerometer({ frequency: 30 });
            acc.addEventListener('reading', function() {
                // Calculate pitch angle from raw X,Y,Z acceleration vectors
                var pitch = Math.atan2(acc.y, Math.sqrt(acc.x*acc.x + acc.z*acc.z)) * (180 / Math.PI);
                updateTilt(Math.abs(pitch)); 
            });
            acc.start();
        } catch (e) {
            setupFallbackSensor();
        }
    } else {
        setupFallbackSensor();
    }

    // Attempt 2: Legacy DeviceOrientation (Accelerometer + Gyro fusion)
    function setupFallbackSensor() {
        window.addEventListener('deviceorientation', function(event) {
            if (event.beta !== null) {
                updateTilt(event.beta);
            }
        });
    }
};

// ---------- START ----------
async function start() {
    $btnStart.disabled = true;
    $btnStart.textContent = 'Starting...';
    $loading.classList.remove('hidden');
    $loading.textContent = '⏳ Starting camera...';

    try {
        var stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' }
        });
        $video.srcObject = stream;
        await $video.play();
        $loading.textContent = '⏳ Loading ML face model...';

        var fm = new FaceMesh({
            locateFile: function(f) {
                return 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/' + f;
            }
        });
        fm.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        fm.onResults(onFace);

        var cam = new Camera($video, {
            onFrame: async function() { await fm.send({ image: $video }); },
            width: 640, height: 480
        });
        await cam.start();

        $loading.textContent = '✅ ML ready! Starting...';
        setTimeout(function() {
            $start.classList.remove('active');
            $start.classList.add('hidden');
            launchGame();
        }, 500);
    } catch(e) {
        $btnStart.disabled = false;
        $btnStart.textContent = '🎮 Start Game';
        $loading.textContent = '❌ ' + e.message;
        console.error(e);
    }
}

// ---------- ML FACE CALLBACK (every frame ~30fps) ----------
function onFace(r) {
    if (!r.multiFaceLandmarks || r.multiFaceLandmarks.length === 0) {
        if (!calibrating) updateGaze(true);
        return;
    }
    var lm = r.multiFaceLandmarks[0];

    // -- SIGNAL 1: Iris vertical position --
    var lH = lm[145].y - lm[159].y;
    var lR = lH > 0.001 ? (lm[468].y - lm[159].y) / lH : 0.5;
    var rH = lm[374].y - lm[386].y;
    var rR = rH > 0.001 ? (lm[473].y - lm[386].y) / rH : 0.5;
    var iris = (lR + rR) / 2;

    // -- SIGNAL 2: Head pitch --
    var fH = lm[152].y - lm[10].y;
    var head = fH > 0.001 ? (lm[4].y - lm[10].y) / fH : 0.5;

    // -- SIGNAL 3: Eye Aspect Ratio (eyelid openness) --
    var ear = (calcEAR(lm, 33,133,160,158,144,153) + calcEAR(lm, 362,263,385,387,380,373)) / 2;

    // Push to smoothing buffers
    irisBuffer.push(iris);
    headBuffer.push(head);
    earBuffer.push(ear);
    if (irisBuffer.length > SMOOTH_FRAMES) irisBuffer.shift();
    if (headBuffer.length > SMOOTH_FRAMES) headBuffer.shift();
    if (earBuffer.length > SMOOTH_FRAMES) earBuffer.shift();

    // Smoothed values
    var sIris = avg(irisBuffer);
    var sHead = avg(headBuffer);
    var sEAR = avg(earBuffer);

    if (calibrating) {
        calSamples.push({ iris: sIris, head: sHead, ear: sEAR });
        var left = Math.ceil((CAL_MS - (Date.now() - calStart)) / 1000);
        if ($calMsg) $calMsg.textContent = '👀 Keep looking at screen... ' + Math.max(0, left) + 's';
        if (Date.now() - calStart >= CAL_MS) finishCal();
        return;
    }

    // Detection: how far has each signal deviated from baseline?
    var irisDelta = sIris - bIris;    // positive = looking more down
    var headDelta = bHead - sHead;    // positive = head tilted more down
    var earDelta = bEAR - sEAR;       // positive = eyelids more closed

    // -- Calculate Face Angle over Screen --
    var dy = lm[152].y - lm[10].y;
    var dz = lm[152].z - lm[10].z;
    var pitchDeg = Math.atan2(dz, dy) * (180 / Math.PI);
    // Looking straight ahead gives pitchDeg ~ 0, so angle to screen is ~ 90
    // Looking down increases pitchDeg, lowering the angle (e.g. 45)
    var faceAngle = Math.round(90 - pitchDeg);
    var $angleVal = document.getElementById('head-angle-val');
    if ($angleVal) $angleVal.textContent = faceAngle;

    // Score: weighted combination. Iris is most reliable.
    // Each delta is compared to a small threshold to see if it's significant
    var lookingDown = (irisDelta > 0.04) || (headDelta > 0.03 && irisDelta > 0.02) || (earDelta > 0.02 && irisDelta > 0.02);

    updateGaze(lookingDown);
}

function calcEAR(lm, c1, c2, u1, u2, l1, l2) {
    var v1 = dist(lm[u1], lm[l1]);
    var v2 = dist(lm[u2], lm[l2]);
    var h = dist(lm[c1], lm[c2]);
    return h < 0.001 ? 0.3 : (v1 + v2) / (2 * h);
}

function dist(a, b) { return Math.sqrt((a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y)); }
function avg(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return arr.length ? s / arr.length : 0; }

// ---------- CALIBRATION FINISH ----------
function finishCal() {
    calibrating = false;
    if (calSamples.length > 0) {
        var si = 0, sh = 0, se = 0;
        for (var i = 0; i < calSamples.length; i++) {
            si += calSamples[i].iris;
            sh += calSamples[i].head;
            se += calSamples[i].ear;
        }
        bIris = si / calSamples.length;
        bHead = sh / calSamples.length;
        bEAR = se / calSamples.length;
        console.log('Calibrated! Baseline → iris:', bIris.toFixed(3), 'head:', bHead.toFixed(3), 'EAR:', bEAR.toFixed(3));
    }
    if ($calMsg) $calMsg.classList.add('hidden');
    $input.disabled = false;
    $input.focus();
}

// ---------- GAZE STATE ----------
function updateGaze(down) {
    isDown = down;
    if (down) {
        $gazeInd.className = 'gaze-down';
        $gazeIcon.textContent = '👇';
        $gazeTxt.textContent = 'Looking Down!';
    } else {
        $gazeInd.className = 'gaze-up';
        $gazeIcon.textContent = '👀';
        $gazeTxt.textContent = 'Eyes on Screen';
    }
}

// ---------- CLOUDS ----------
function makeClouds() {
    var c = document.getElementById('clouds');
    if (!c) return;
    for (var i = 0; i < 6; i++) {
        var d = document.createElement('div');
        d.className = 'cloud';
        d.style.width = (80 + Math.random() * 140) + 'px';
        d.style.height = (30 + Math.random() * 30) + 'px';
        d.style.top = (5 + Math.random() * 40) + '%';
        d.style.left = (Math.random() * 100) + '%';
        d.style.animationDuration = (25 + Math.random() * 35) + 's';
        d.style.animationDelay = (-Math.random() * 30) + 's';
        d.style.opacity = String(0.5 + Math.random() * 0.4);
        c.appendChild(d);
    }
}

// ---------- LIVES ----------
function drawLives() {
    $lives.innerHTML = '';
    for (var i = 0; i < MAX_LIVES; i++) {
        var s = document.createElement('span');
        s.textContent = i < lives ? '❤️' : '🖤';
        $lives.appendChild(s);
    }
}

// ---------- GAME ----------
function launchGame() {
    $game.classList.remove('hidden');
    running = true;
    calibrating = true;
    calStart = Date.now();
    calSamples = [];
    irisBuffer = [];
    headBuffer = [];
    earBuffer = [];
    $input.disabled = true;
    if ($calMsg) $calMsg.classList.remove('hidden');

    spawn();
    timer = setInterval(function() {
        if (running && bubbles.length < MAX_BUBBLES) spawn();
    }, SPAWN_MS);
}

function pick() {
    var a = WORDS.filter(function(w) { return !used.has(w); });
    if (!a.length) { used.clear(); a = WORDS.slice(); }
    var w = a[Math.floor(Math.random() * a.length)];
    used.add(w);
    return w;
}

function spawn() {
    var w = pick();
    var id = 'b' + bid++;
    var col = COLORS[Math.floor(Math.random() * COLORS.length)];
    var el = document.createElement('div');
    el.className = 'word-bubble ' + col;
    el.id = id;
    el.style.left = (10 + Math.random() * 75) + '%';
    el.style.animationDuration = FLOAT_MS + 'ms';

    var bl = document.createElement('div');
    bl.className = 'bubble-balloon';
    var sp = document.createElement('span');
    sp.className = 'bubble-word';
    sp.textContent = w;
    bl.appendChild(sp);

    var st = document.createElement('div');
    st.className = 'bubble-string';

    el.appendChild(bl);
    el.appendChild(st);
    $bubbles.appendChild(el);

    var entry = { word: w, el: el, id: id };
    bubbles.push(entry);
    if (!target) setTarget(entry);
    el.addEventListener('animationend', function() { removeBubble(entry, true); });
}

function setTarget(e) {
    if (target && target.el) target.el.classList.remove('active-target');
    target = { word: e.word, el: e.el, id: e.id, typed: '', downAt: [] };
    e.el.classList.add('active-target');
    renderWord();
}

function renderWord() {
    if (!target) { $target.textContent = '—'; return; }
    $target.innerHTML = '';
    var ds = new Set(target.downAt);
    for (var i = 0; i < target.word.length; i++) {
        var s = document.createElement('span');
        s.textContent = target.word[i];
        if (i < target.typed.length) s.className = ds.has(i) ? 'down-char' : 'typed-char';
        $target.appendChild(s);
    }
}

function removeBubble(e, escaped) {
    var i = bubbles.findIndex(function(b) { return b.id === e.id; });
    if (i !== -1) bubbles.splice(i, 1);
    if (e.el && e.el.parentNode) {
        if (!escaped) { e.el.classList.add('popped'); setTimeout(function() { if (e.el.parentNode) e.el.parentNode.removeChild(e.el); }, 400); }
        else e.el.parentNode.removeChild(e.el);
    }
    if (target && target.id === e.id) {
        target = null;
        $input.value = '';
        if (bubbles.length > 0) setTarget(bubbles[0]);
    }
}

// ---------- TYPING ----------
function onType() {
    if (penalty || !target || !running || calibrating) {
        $input.value = target ? target.typed : '';
        return;
    }
    var v = $input.value.toLowerCase();
    if (v.length > target.typed.length) {
        var ci = v.length - 1;
        if (v[ci] === target.word[ci]) {
            target.typed = v;
            if (isDown) {
                target.downAt.push(ci);
                downs++;
                $downs.textContent = downs;
                lives--;
                drawLives();
                renderWord();
                showPenalty(target.word, v[ci]);
                if (lives <= 0) { setTimeout(endGame, PENALTY_MS + 200); return; }
            } else {
                renderWord();
            }
            if (target.typed.length === target.word.length) wordDone();
        } else {
            $input.value = target.typed;
        }
    } else if (v.length < target.typed.length) {
        $input.value = target.typed;
    }
}

function wordDone() {
    score++;
    $score.textContent = score;
    if (target.downAt.length > 0) {
        var dl = target.downAt.map(function(i) { return target.word[i]; });
        log.push({ time: new Date().toLocaleTimeString(), word: target.word, chars: dl.join(', ') });
    }
    var e = bubbles.find(function(b) { return b.id === target.id; });
    if (e) removeBubble(e, false); else target = null;
    $input.value = '';
    if (!target && bubbles.length > 0) setTarget(bubbles[0]);
}

// ---------- PENALTY ----------
function showPenalty(w, ch) {
    penalty = true;
    $penInfo.textContent = 'You typed "' + ch + '" in "' + w + '" while looking down!';
    $penOver.classList.remove('hidden');
    setTimeout(function() { $penOver.classList.add('hidden'); penalty = false; $input.focus(); }, PENALTY_MS);
}

// ---------- END ----------
function endGame() {
    running = false;
    if (timer) clearInterval(timer);
    $game.classList.add('hidden');
    $results.classList.remove('hidden');
    $rScore.textContent = score;
    $rDown.textContent = downs;

    var uw = [];
    log.forEach(function(l) { if (uw.indexOf(l.word) === -1) uw.push(l.word); });
    $dWords.innerHTML = '';
    if (!uw.length) {
        $dWords.innerHTML = '<span style="color:#4caf50;font-weight:700">🎉 Perfect! Never looked down!</span>';
    } else {
        uw.forEach(function(w) { var b = document.createElement('span'); b.className = 'down-word-badge'; b.textContent = w; $dWords.appendChild(b); });
    }
    $logBody.innerHTML = '';
    if (!log.length) {
        $logBody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#4caf50">No infractions!</td></tr>';
    } else {
        log.forEach(function(l) { var tr = document.createElement('tr'); tr.innerHTML = '<td>'+l.time+'</td><td>'+l.word+'</td><td style="color:#f44336;font-weight:700">'+l.chars+'</td>'; $logBody.appendChild(tr); });
    }
}
