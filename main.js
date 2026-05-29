// State
let isCalibrating = false;
let isReading = false;
let calibrationClicks = {};
let currentCharIndex = 0;
let infractionLog = [];
let gazeLostStartTime = null;

// Constants
const CALIBRATION_CLICKS_REQUIRED = 5;
const PENALTY_TIMEOUT_MS = 2000; // Look away for 2 seconds triggers penalty
const PENALTY_OVERLAY_DURATION = 3000;
let isPenalized = false;

// DOM Elements
const setupSection = document.getElementById('setup-section');
const readingSection = document.getElementById('reading-section');
const summarySection = document.getElementById('summary-section');
const startCalibrationBtn = document.getElementById('start-calibration-btn');
const calibrationDotsContainer = document.getElementById('calibration-dots-container');
const textContainer = document.getElementById('text-container');
const penaltyOverlay = document.getElementById('penalty-overlay');
const finishReadingBtn = document.getElementById('finish-reading-btn');
const infractionTbody = document.getElementById('infraction-tbody');
const infractionCount = document.getElementById('infraction-count');
const restartBtn = document.getElementById('restart-btn');
const calibrationStatusBadge = document.getElementById('calibration-status');
const trackingStatusBadge = document.getElementById('tracking-status');
const typingInput = document.getElementById('typing-input');

// Sample Text
const sampleText = "The quick brown fox jumps over the lazy dog. Typing requires you to look at the screen, not the keyboard!";
const textChars = sampleText.split('');

// Initialization
window.onload = async function() {
    startCalibrationBtn.addEventListener('click', startCalibration);
    finishReadingBtn.addEventListener('click', finishReading);
    restartBtn.addEventListener('click', () => window.location.reload());

    // Initialize WebGazer but pause it until user clicks start
    webgazer.params.showVideoPreview = true;
    
    // Typing input listener
    typingInput.addEventListener('input', handleTyping);
};

async function startCalibration() {
    startCalibrationBtn.disabled = true;
    startCalibrationBtn.innerText = "Initializing Camera...";

    await webgazer.setRegression('ridge')
        .setGazeListener(gazeListener)
        .begin();

    webgazer.showVideoPreview(true)
        .showPredictionPoints(true)
        .applyHideHelpButton(true);

    isCalibrating = true;
    setupSection.classList.add('hidden');
    calibrationDotsContainer.classList.remove('hidden');
    calibrationStatusBadge.innerText = "Calibrating...";
    calibrationStatusBadge.className = "status-badge pending";

    generateCalibrationDots();
}

function generateCalibrationDots() {
    calibrationDotsContainer.innerHTML = '';
    const points = [
        [10, 10], [50, 10], [90, 10],
        [10, 50], [50, 50], [90, 50],
        [10, 90], [50, 90], [90, 90]
    ];

    points.forEach((point, index) => {
        const dot = document.createElement('div');
        dot.className = 'calibration-dot';
        dot.style.left = `${point[0]}vw`;
        dot.style.top = `${point[1]}vh`;
        dot.id = `dot-${index}`;
        calibrationClicks[dot.id] = 0;

        dot.addEventListener('click', () => {
            calibrationClicks[dot.id]++;
            dot.style.opacity = Math.max(0.2, 1 - (calibrationClicks[dot.id] / CALIBRATION_CLICKS_REQUIRED));
            
            if (calibrationClicks[dot.id] >= CALIBRATION_CLICKS_REQUIRED) {
                dot.style.display = 'none';
                checkCalibrationComplete();
            }
        });

        calibrationDotsContainer.appendChild(dot);
    });
}

function checkCalibrationComplete() {
    const allDone = Object.values(calibrationClicks).every(clicks => clicks >= CALIBRATION_CLICKS_REQUIRED);
    if (allDone) {
        isCalibrating = false;
        calibrationDotsContainer.classList.add('hidden');
        calibrationStatusBadge.innerText = "Calibrated";
        calibrationStatusBadge.className = "status-badge tracking";
        
        startReadingPhase();
    }
}

function startReadingPhase() {
    isReading = true;
    readingSection.classList.remove('hidden');
    trackingStatusBadge.innerText = "Tracking Active";
    trackingStatusBadge.className = "status-badge tracking";
    
    // Hide video and prediction point for reading phase to avoid distraction
    webgazer.showVideoPreview(false);
    webgazer.showPredictionPoints(false);

    // Tokenize text into characters
    textContainer.innerHTML = '';
    textChars.forEach((char, index) => {
        const span = document.createElement('span');
        span.className = 'char-token';
        span.id = `char-${index}`;
        span.innerText = char;
        textContainer.appendChild(span);
    });

    updateTypingUI();
    typingInput.focus();
}

function handleTyping(e) {
    if (isPenalized) {
        e.preventDefault();
        typingInput.value = typingInput.value.slice(0, -1);
        return;
    }

    const typedValue = typingInput.value;
    const typedChar = typedValue[typedValue.length - 1];
    const expectedChar = textChars[currentCharIndex];

    if (!typedChar) return; // Handle backspace if needed, though we restrict it simply here

    if (typedChar === expectedChar) {
        // Correct char
        const charElem = document.getElementById(`char-${currentCharIndex}`);
        charElem.classList.remove('current', 'incorrect');
        charElem.classList.add('correct');
        
        currentCharIndex++;
        
        if (currentCharIndex >= textChars.length) {
            finishReading();
        } else {
            updateTypingUI();
        }
    } else {
        // Incorrect char
        const charElem = document.getElementById(`char-${currentCharIndex}`);
        charElem.classList.add('incorrect');
        // Remove the incorrectly typed char from input
        typingInput.value = typingInput.value.slice(0, -1);
    }
}

function updateTypingUI() {
    if (currentCharIndex < textChars.length) {
        const charElem = document.getElementById(`char-${currentCharIndex}`);
        charElem.classList.add('current');
    }
}

function gazeListener(data, elapsedTime) {
    if (!isReading || isPenalized) return;

    if (data == null) {
        // Face lost (looked away or down)
        if (!gazeLostStartTime) {
            gazeLostStartTime = elapsedTime;
        } else if (elapsedTime - gazeLostStartTime > PENALTY_TIMEOUT_MS) {
            triggerPenalty("Face not detected (looked away/down)");
        }
        return;
    }

    // Face detected, reset timer
    gazeLostStartTime = null;

    // Check if looking too far down (simulating looking at keyboard)
    // If y is close to or greater than window height
    if (data.y > window.innerHeight - 100) {
        triggerPenalty("Looked down at keyboard");
        return;
    }
}

function triggerPenalty(reason) {
    isPenalized = true;
    
    let targetChar = textChars[currentCharIndex] || "N/A";
    if (targetChar === " ") targetChar = "[Space]";

    // Get the current word being typed for context
    let wordStart = currentCharIndex;
    while (wordStart > 0 && textChars[wordStart - 1] !== ' ') wordStart--;
    let wordEnd = currentCharIndex;
    while (wordEnd < textChars.length && textChars[wordEnd] !== ' ') wordEnd++;
    let targetWord = textChars.slice(wordStart, wordEnd).join('');
    
    const targetContext = `Char: '${targetChar}' (in word: "${targetWord}")`;

    // Record Infraction
    const infraction = {
        time: new Date().toLocaleTimeString(),
        word: targetContext,
        reason: reason
    };
    infractionLog.push(infraction);

    // Show Overlay
    penaltyOverlay.classList.remove('hidden');
    
    // Hide after duration
    setTimeout(() => {
        penaltyOverlay.classList.add('hidden');
        isPenalized = false;
        gazeLostStartTime = null; // Reset
        typingInput.focus();
    }, PENALTY_OVERLAY_DURATION);
}

function finishReading() {
    isReading = false;
    webgazer.pause();
    
    readingSection.classList.add('hidden');
    summarySection.classList.remove('hidden');
    trackingStatusBadge.innerText = "Session Ended";
    trackingStatusBadge.className = "status-badge stopped";

    // Populate summary
    infractionCount.innerText = infractionLog.length;
    
    infractionTbody.innerHTML = '';
    if (infractionLog.length === 0) {
        infractionTbody.innerHTML = '<tr><td colspan="3" style="text-align:center">Great focus! No infractions recorded.</td></tr>';
    } else {
        infractionLog.forEach(log => {
            const tr = document.createElement('tr');
            tr.innerHTML = \`
                <td>\${log.time}</td>
                <td><strong>\${log.word}</strong></td>
                <td>\${log.reason}</td>
            \`;
            infractionTbody.appendChild(tr);
        });
    }
}
