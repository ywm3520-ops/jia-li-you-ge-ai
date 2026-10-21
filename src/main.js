const BEHAVIOR_MODE = 'normal'; // quiet | normal | active
const MEMORY_KEY = 'jia-li-you-ge-ai-memory-v1';
const GREET_COOLDOWN = 4 *  60 * 1000;
const $ = (selector) => document.querySelector(selector);
const buddy = $('#buddy');
const hint = $('#hint');
const stateLabel = $('#stateLabel');
const conversation = $('#conversation');
const talkButton = $('#talkButton');
const buttonText = $('#buttonText');
const supportNote = $('#supportNote');
const messageInput = $('#messageInput');
const cameraButton = $('#cameraButton');
const cameraNote = $('#cameraNote');
const video = $('#cameraVideo');
const states = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'NOTICE', 'OFFLINE'];
let currentState = 'IDLE';
let speechUnlocked = false;
let speechTaskId = 0;
let activeSpeech = null;
let recognition = null;
let recognitionSessionId = 0;
let recognitionInstanceId = 0;
let recognitionSessionActive = false;
let recognitionUserStopped = false;
let recognitionPhase = 'idle';
let recognitionRetryTimer = null;
let recognitionRetryCount = 0;
let cameraStream = null;
let cameraTimer = null;
let previousFrame = null;
let lastMotionAt = 0;
let lastGreeting = '';
let messageTaskId = 0;
let memory = loadMemory();

function loadMemory() {
  try {
    const saved = JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
    return { name: typeof saved.name === 'string' ? saved.name : '', preference: typeof saved.preference === 'string' ? saved.preference : '', recent: Array.isArray(saved.recent) ? saved.recent.slice(-10) : [], lastGreetingAt: Number(saved.lastGreetingAt) || 0 };
  } catch { return { name: '', preference: '', recent: [], lastGreetingAt: 0 }; }
}

function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch { /* Memory is optional; keep the conversation working. */ }
}

function setState(next) {
  currentState = states.includes(next) ? next : 'IDLE';
  buddy.dataset.state = currentState.toLowerCase();
  document.body.dataset.state = currentState.toLowerCase();
  stateLabel.textContent = ({ IDLE: '安静陪着你', LISTENING: '我在认真听', THINKING: '让我想一想', SPEAKING: '正在和你说话', NOTICE: '我注意到你啦', OFFLINE: '部分设备能力暂不可用' })[currentState];
}

function addBubble(kind, text) {
  const bubble = document.createElement('p');
  bubble.className = `bubble ${kind}`;
  bubble.textContent = text;
  conversation.append(bubble);
  while (conversation.children.length > 8) conversation.firstElementChild.remove();
  conversation.scrollTop = conversation.scrollHeight;
}

function rememberTurn(userText, answer) {
  memory.recent.push({ user: userText.slice(0, 200), assistant: answer.slice(0, 200), at: Date.now() });
  memory.recent = memory.recent.slice(-10);
  saveMemory();
}

function containsSensitiveInfo(text) {
  return /身份证|身份证号|手机号|手机号码|电话号码|联系电话|住址|家庭住址|详细地址|银行卡|银行卡号|密码|验证码|账号|账户|家人隐私|家庭隐私|\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/.test(text);
}

function detectMemory(text) {
  const patterns = [
    /(?:我喜欢别人叫我|我喜欢你叫我|以后叫我|以后请叫我|以后称呼我|请叫我|请称呼我|称呼我|叫我|我叫|我的名字是)([\u4e00-\u9fa5A-Za-z0-9]{1,12})(?:呀|啊|哦)?[。！!，,？?]?$/
  ];

  for (const pattern of patterns) {
    const match = text.trim().match(pattern);
    if (match && !/家里有个AI|人工智能/.test(match[1])) {
      const name = match[1];
      return {
        reply: `好呀，我记住啦，以后叫你${name}。`,
        update: { name }
      };
    }
  }

  const preferenceMatch = text.match(/我喜欢([^，。！？!?,]{1,20})/);
  if (preferenceMatch) {
    const preference = `喜欢${preferenceMatch[1]}`;
    return {
      reply: `记下来啦，你${preference}。下次聊到它，我可能会想起来。`,
      update: { preference }
    };
  }

  return null;
}

const choose = (items) => items[Math.floor(Math.random() * items.length)];
function generateLocalReply(text, context = {}) {
  const t = text.replace(/[，。！？、,.!？\s]/g, '');
  const name = context.memory?.name;
  if (/几点|现在几点|时间/.test(t)) return `现在大约是${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date())}。`;
  if (/你是谁|你叫什么|介绍一下/.test(t)) return choose(['我是家里有个AI呀，平时就在这儿陪着你。', '我叫家里有个AI，是住在这部手机里的小伙伴。']);
  if (/你在干什么|干嘛呢|做什么呢/.test(t)) return choose(['没干什么，安静地待着呢。你回来我就热闹一点。', '在这儿发会儿呆，顺便等你回来呀。']);
  if (/讲个笑话|说个笑话|笑话/.test(t)) return choose(['有一天，冰箱对牛奶说：你怎么这么冷淡？', '小番茄问番茄酱：你怎么变得这么红？番茄酱说：我有点害羞。']);
  if (/讲个故事|说个故事|故事/.test(t)) return '有颗小星星总觉得自己很暗。一天，它照亮了晚归人的路，才发现一点点光也很有用。';
  if (/唱首歌|唱歌|哼歌/.test(t)) return choose(['嗯……啦啦啦……今天心情不错呀。', '我给你哼一小段：嗯哼，啦啦啦～']);
  if (/不开心|难过|伤心|烦死|沮丧/.test(t)) return choose(['听起来你这会儿不太好受。先歇一歇吧，我陪着你。', '抱抱你。想说的话可以慢慢说，我在听。']);
  if (/累了|好累|疲惫|困了/.test(t)) return choose(['那就歇一会儿吧，我陪你安静一会儿。', '辛苦啦，喝口水、放松一下也好。']);
  if (/无聊|没意思/.test(t)) return choose(['那我们随便聊聊？今天有没有一件小事让你记住？', '我陪你待会儿。要不要听个小笑话？']);
  if (/开心|高兴|太棒|好消息/.test(t)) return choose(['听起来是件开心事！快让我也沾点喜气。', '太好啦，我也替你开心。']);
  if (/回来|回家|到家/.test(t)) return choose(['回来啦？我一直在这儿呢。', '欢迎回家，今天过得怎么样？']);
  if (/谢谢|谢啦/.test(t)) return choose(['不客气呀。', '不用谢，我在呢。']);
  if (/再见|拜拜|晚安/.test(t)) return choose(['好呀，回头见。', '晚安，愿你今晚睡得舒服。']);
  if (/好的|嗯|哦|知道了/.test(t)) return choose(['嗯嗯。', '好呀。', '我听到了。']);
  if (/你好|您好|嗨|哈喽/.test(t)) return name ? `你好，${name}！我在呢。` : choose(['你好呀，我在呢。', '嗨，今天怎么样？']);
  if (context.memory?.preference && Math.random() < 0.16) return `嗯，我记得你${context.memory.preference}。${choose(['说到这个，感觉挺适合你的。', '下次可以再聊聊它。'])}`;
  return choose(['嗯，我听到了。你愿意多说一点吗？', '这个有点意思，我陪你慢慢聊。', '我在呢。今天过得怎么样？', '好呀，我会认真听你说。', '这个我得想一下……你现在心情怎么样？']);
}

async function generateAIReply(text, context) {
  if (containsSensitiveInfo(text)) return { answer: '这类隐私我不会记下来。我们可以聊点别的，我在听。', memoryUpdate: null };
  const remembered = detectMemory(text);
  if (remembered) return { answer: remembered.reply, memoryUpdate: remembered.update };
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        context: { memory: { name: context.memory?.name || '', preference: context.memory?.preference || '' } },
      }),
      signal: AbortSignal.timeout(22_000),
    });
    if (!response.ok) throw new Error('Chat request failed');
    const data = await response.json();
    if (typeof data?.reply !== 'string' || !data.reply.trim()) throw new Error('Invalid chat response');
    return { answer: data.reply.trim(), memoryUpdate: null };
  } catch {
    return { answer: generateLocalReply(text, context), memoryUpdate: null };
  }
}

function finishSpeech(task, spoken) {
  if (task.settled) return;
  task.settled = true;
  if (task.timeoutId !== null) window.clearTimeout(task.timeoutId);
  if (activeSpeech === task && speechTaskId === task.id) {
    activeSpeech = null;
    if (currentState === 'SPEAKING') setState('IDLE');
  }
  task.resolve(spoken);
}

function stopSpeaking() {
  const task = activeSpeech;
  speechTaskId++;
  activeSpeech = null;
  if (task && !task.settled) {
    task.settled = true;
    if (task.timeoutId !== null) window.clearTimeout(task.timeoutId);
    task.resolve(false);
  }
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* Ignore browser cancellation races. */ }
  if (currentState === 'SPEAKING') setState('IDLE');
}

function safeSpeak(text, { userInitiated = false } = {}) {
  if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return Promise.resolve(false);
  if (!userInitiated && !speechUnlocked) return Promise.resolve(false);
  return new Promise((resolve) => {
    stopSpeaking();
    const task = { id: ++speechTaskId, utterance: null, timeoutId: null, resolve, settled: false };
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      task.utterance = utterance;
      activeSpeech = task;
      utterance.lang = 'zh-CN'; utterance.rate = 0.94;
      utterance.onstart = () => {
        if (activeSpeech === task && speechTaskId === task.id) setState('SPEAKING');
      };
      utterance.onend = () => finishSpeech(task, true);
      utterance.onerror = () => finishSpeech(task, false);
      task.timeoutId = window.setTimeout(() => {
        if (activeSpeech === task && speechTaskId === task.id) stopSpeaking();
      }, 18000);
      window.speechSynthesis.speak(utterance);
    } catch {
      finishSpeech(task, false);
    }
  });
}

function invalidateMessageTasks() {
  messageTaskId++;
  return messageTaskId;
}

function isStopCommand(text) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\s，。！？、,.!?;；:："“”‘’（）()【】\[\]{}…—\-~～]+/g, '');
  return new Set(['停', '停止', '停一下', '先停', '先停一下', '别说了', '先别说了', '不要说话', '不要说了', '先不要说话', '先不要说了', '别说话', '别说话了']).has(normalized);
}

async function processMessage(text, { speak = true } = {}) {
  const clean = text.trim().slice(0, 200);
  if (!clean) return;
  const taskId = invalidateMessageTasks();
  addBubble('user-bubble', clean);
  hint.textContent = `你说：“${clean}”`;
  setState('THINKING');
  let result;
  try { result = await generateAIReply(clean, { memory: { ...memory }, recent: memory.recent.slice(-4) }); }
  catch { result = { answer: '我刚才走了下神，再跟我说一遍好吗？', memoryUpdate: null }; }
  if (taskId !== messageTaskId) return;
  const answer = result.answer;
  if (result.memoryUpdate?.name) memory.name = result.memoryUpdate.name;
  if (result.memoryUpdate?.preference) memory.preference = result.memoryUpdate.preference;
  addBubble('ai-bubble', answer);
  if (!containsSensitiveInfo(clean)) rememberTurn(clean, answer);
  if (speak) await safeSpeak(answer);
  if (taskId !== messageTaskId) return;
  if (!activeSpeech && currentState !== 'LISTENING') setState('IDLE');
}

function clearRecognitionRetry() {
  if (recognitionRetryTimer !== null) window.clearTimeout(recognitionRetryTimer);
  recognitionRetryTimer = null;
}

function recognitionAttemptIsCurrent(sessionId, instanceId, instance) {
  return sessionId === recognitionSessionId && instanceId === recognitionInstanceId && recognition === instance;
}

function endRecognitionSession({ userStopped = false } = {}) {
  recognitionSessionActive = false;
  recognitionUserStopped = userStopped;
  recognitionSessionId++;
  recognitionInstanceId++;
  clearRecognitionRetry();
  const previousRecognition = recognition;
  recognition = null;
  recognitionPhase = 'idle';
  buttonText.textContent = '和我说话';
  if (currentState === 'LISTENING') setState('IDLE');
  try { previousRecognition?.stop(); } catch { /* Ignore browser shutdown races. */ }
}

function scheduleRecognitionRetry(Recognition, sessionId) {
  const delays = [500, 1000, 2000];
  if (!recognitionSessionActive || recognitionUserStopped || sessionId !== recognitionSessionId || recognitionRetryTimer !== null) return;
  if (recognitionRetryCount >= delays.length) {
    recognitionSessionActive = false;
    recognitionPhase = 'idle';
    buttonText.textContent = '和我说话';
    hint.textContent = '语音识别连续中断，请点击按钮重试，也可以使用文字聊天。';
    if (currentState === 'LISTENING') setState('IDLE');
    return;
  }
  const delay = delays[recognitionRetryCount++];
  recognitionPhase = 'idle';
  buttonText.textContent = '正在重新连接……';
  hint.textContent = '语音识别暂时中断，正在重试……';
  recognitionRetryTimer = window.setTimeout(() => {
    recognitionRetryTimer = null;
    if (!recognitionSessionActive || recognitionUserStopped || sessionId !== recognitionSessionId || recognitionPhase !== 'idle') return;
    startRecognitionAttempt(Recognition, sessionId);
  }, delay);
}

function startRecognitionAttempt(Recognition, sessionId) {
  if (!recognitionSessionActive || recognitionUserStopped || sessionId !== recognitionSessionId || recognitionPhase !== 'idle') return;
  const instanceId = ++recognitionInstanceId;
  let instance = null;
  let finalResultHandled = false;
  let terminalError = false;
  const processedFinalIndexes = new Set();
  try {
    instance = new Recognition();
    recognition = instance;
    recognitionPhase = 'starting';
    instance.lang = 'zh-CN'; instance.interimResults = true; instance.maxAlternatives = 1;
    instance.onstart = () => {
      if (!recognitionAttemptIsCurrent(sessionId, instanceId, instance)) return;
      recognitionPhase = 'listening';
      buttonText.textContent = '我在听……';
      hint.textContent = '我在听……';
      if (!activeSpeech) setState('LISTENING');
    };
    instance.onresult = (event) => {
      if (!recognitionAttemptIsCurrent(sessionId, instanceId, instance) || finalResultHandled || terminalError) return;
      const firstChangedIndex = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
      for (let index = firstChangedIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim();
        if (transcript) hint.textContent = `听到：${transcript}`;
        if (!result?.isFinal || processedFinalIndexes.has(index)) continue;
        processedFinalIndexes.add(index);
        if (!transcript) continue;
        finalResultHandled = true;
        recognitionSessionActive = false;
        clearRecognitionRetry();
        if (isStopCommand(transcript)) {
          invalidateMessageTasks();
          stopSpeaking();
          hint.textContent = '好，我先不说了。';
          if (currentState !== 'LISTENING') setState('IDLE');
          return;
        }
        // This one-shot result supersedes any older message/speech, while processMessage
        // assigns the new task its own latest messageTaskId.
        invalidateMessageTasks();
        stopSpeaking();
        void processMessage(transcript);
        return;
      }
    };
    instance.onerror = (event) => {
      if (!recognitionAttemptIsCurrent(sessionId, instanceId, instance)) return;
      const error = event.error;
      const permanentErrors = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'];
      const permissionError = error === 'not-allowed' || error === 'service-not-allowed';
      hint.textContent = permissionError
        ? '需要允许麦克风权限才能听你说话，也可以用文字告诉我。'
        : '刚才没有听清，再试一次或用文字告诉我吧。';
      if (permanentErrors.includes(error)) {
        terminalError = true;
        recognitionSessionActive = false;
        clearRecognitionRetry();
      }
      if (!activeSpeech) setState('IDLE');
    };
    instance.onend = () => {
      if (!recognitionAttemptIsCurrent(sessionId, instanceId, instance)) return;
      recognition = null;
      recognitionPhase = 'idle';
      buttonText.textContent = '和我说话';
      if (currentState === 'LISTENING') setState('IDLE');
      if (finalResultHandled || terminalError || !recognitionSessionActive || recognitionUserStopped) {
        recognitionSessionActive = false;
        return;
      }
      scheduleRecognitionRetry(Recognition, sessionId);
    };
    instance.start();
  } catch {
    if (instance && !recognitionAttemptIsCurrent(sessionId, instanceId, instance)) return;
    recognition = null;
    recognitionPhase = 'idle';
    hint.textContent = '麦克风暂时没准备好，可以先用文字和我说话。';
    if (!activeSpeech) setState('IDLE');
    scheduleRecognitionRetry(Recognition, sessionId);
  }
}

function startListening() {
  speechUnlocked = true;
  if (recognitionSessionActive || recognitionPhase !== 'idle' || recognitionRetryTimer !== null) {
    endRecognitionSession({ userStopped: true });
    return;
  }
  // Keep the verified first-tap greeting in the user gesture, before requesting the mic.
  void safeSpeak('你好，我是阿明。', { userInitiated: true });
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    hint.textContent = '这个浏览器暂时听不到你的声音，可以先用文字和我说话。';
    supportNote.textContent = '语音识别暂不可用，下面的文字输入仍然可以使用';
    setState('OFFLINE');
    return;
  }
  recognitionSessionId++;
  recognitionSessionActive = true;
  recognitionUserStopped = false;
  recognitionRetryCount = 0;
  clearRecognitionRetry();
  startRecognitionAttempt(Recognition, recognitionSessionId);
}

function greetingLine() {
  const lines = ['回来啦？', '我在这儿呢。', '今天怎么样？', '看到你了。', '你回来啦，我还在家呢。', '刚才还挺安静的。', '嘿，我注意到你了。', '回来就好。', '我一直在这儿呢。', '今天过得怎么样？'];
  let line = choose(lines);
  if (line === lastGreeting) line = lines[(lines.indexOf(line) + 1 + Math.floor(Math.random() * (lines.length - 1))) % lines.length];
  lastGreeting = line;
  return line;
}

async function noticePresence({ simulated = false } = {}) {
  const now = Date.now();
  if (now - memory.lastGreetingAt < GREET_COOLDOWN) return;
  const probability = BEHAVIOR_MODE === 'quiet' ? 0.22 : BEHAVIOR_MODE === 'active' ? 0.78 : 0.48;
  if (!simulated && Math.random() > probability) return;
  memory.lastGreetingAt = now; saveMemory();
  const line = greetingLine();
  setState('NOTICE'); hint.textContent = line; addBubble('ai-bubble', line);
  const speech = simulated ? safeSpeak(line, { userInitiated: true }) : null;
  await new Promise((resolve) => window.setTimeout(resolve, 650));
  if (simulated) await speech;
  else if (speechUnlocked) await safeSpeak(line);
  if (!activeSpeech && currentState !== 'SPEAKING') setState('IDLE');
}

function stopCamera() {
  if (cameraTimer) window.clearInterval(cameraTimer);
  cameraTimer = null; previousFrame = null;
  if (cameraStream) cameraStream.getTracks().forEach((track) => { try { track.stop(); } catch { /* Track may already be ended. */ } });
  cameraStream = null; video.srcObject = null; cameraButton.textContent = '开启有人感应';
}

function inspectFrame() {
  if (!video.videoWidth || video.readyState < 2) return;
  try {
    const canvas = inspectFrame.canvas || (inspectFrame.canvas = document.createElement('canvas'));
    canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = new Uint8Array(canvas.width * canvas.height);
    for (let p = 0, i = 0; p < pixels.length; p += 4, i++) gray[i] = (pixels[p] * 3 + pixels[p + 1] * 6 + pixels[p + 2]) / 10;
    if (previousFrame) {
      let changed = 0;
      for (let i = 0; i < gray.length; i++) if (Math.abs(gray[i] - previousFrame[i]) > 28) changed++;
      const ratio = changed / gray.length;
      if (ratio > 0.13 && Date.now() - lastMotionAt > 12000) { lastMotionAt = Date.now(); void noticePresence(); }
    }
    previousFrame = gray;
  } catch { cameraNote.textContent = '本地画面检测暂不可用，你仍然可以和我说话。'; stopCamera(); setState('OFFLINE'); }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraNote.textContent = '这个浏览器不支持摄像头感应，你仍然可以和我说话。'; setState('OFFLINE'); return;
  }
  cameraButton.disabled = true;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 160 }, height: { ideal: 120 }, frameRate: { ideal: 4, max: 6 } }, audio: false });
    video.srcObject = cameraStream;
    await video.play();
    cameraButton.textContent = '关闭有人感应'; cameraNote.textContent = '感应已开启：只在本机每 700 毫秒检查一次画面变化';
    cameraStream.getVideoTracks()[0]?.addEventListener('ended', () => { stopCamera(); cameraNote.textContent = '摄像头已断开，你仍然可以和我说话。'; setState('OFFLINE'); }, { once: true });
    cameraTimer = window.setInterval(inspectFrame, 700);
  } catch (error) {
    const reasons = {
      NotAllowedError: '你拒绝了摄像头权限。',
      NotFoundError: '没有找到摄像头。',
      NotReadableError: '摄像头可能被其他程序占用。',
      SecurityError: '浏览器安全策略阻止了摄像头访问。',
    };
    const reason = reasons[error?.name] || `错误类型：${error?.name || '未知错误'}`;
    stopCamera(); cameraNote.textContent = `没有开启摄像头权限或摄像头不可用；${reason}文字和语音互动仍可使用。`; setState('OFFLINE');
  } finally { cameraButton.disabled = false; }
}

talkButton.addEventListener('click', startListening);

$('#textForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value;
  messageInput.value = '';
  if (!text.trim()) return;

  if (isStopCommand(text)) {
    invalidateMessageTasks();
    stopSpeaking();
    endRecognitionSession();
    hint.textContent = '好，我先不说了。';
    setState('IDLE');
    return;
  }

  invalidateMessageTasks();
  stopSpeaking();
  endRecognitionSession();
  void processMessage(text);
});

cameraButton.addEventListener('click', () => cameraStream ? stopCamera() : void startCamera());
$('#simulateButton').addEventListener('click', () => { lastMotionAt = Date.now(); memory.lastGreetingAt = 0; void noticePresence({ simulated: true }); });
window.addEventListener('pagehide', stopCamera);
window.setTimeout(() => {
  const greeting = '你好，我在家呢。';
  addBubble('ai-bubble', greeting);
  hint.textContent = greeting;
}, 3000);

if (!('speechSynthesis' in window) && !(window.SpeechRecognition || window.webkitSpeechRecognition)) setState('OFFLINE');
