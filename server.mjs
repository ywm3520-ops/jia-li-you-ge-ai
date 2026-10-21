import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function handleChat(request, response) {
  let raw = '';
  let tooLarge = false;

  for await (const chunk of request) {
    if (tooLarge) continue;
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      raw = '';
      tooLarge = true;
    }
  }

  if (tooLarge) {
    sendJson(response, 413, { error: '请求内容过大' });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(response, 400, { error: '请求格式无效' });
    return;
  }

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof body.text !== 'string' ||
    !body.text.trim() ||
    body.text.length > 200
  ) {
    sendJson(response, 400, { error: '消息内容无效' });
    return;
  }

  if (/(天气|气温|温度|下雨|降雨|下雪)/.test(body.text)) {
    try {
      const reply = await getWeatherReply(body.text);
      sendJson(response, 200, { reply });
    } catch {
      sendJson(response, 200, { reply: '抱歉，我暂时没能查到实时天气，请稍后再问我。' });
    }
    return;
  }

  const memory = body.context?.memory;
  const name = typeof memory?.name === 'string' ? memory.name.slice(0, 12) : '';
  const preference = typeof memory?.preference === 'string' ? memory.preference.slice(0, 24) : '';

  const systemPrompt = `你的名字只叫“阿明”。当用户问你是谁、叫什么名字时，明确回答“我是阿明”。你是一个温暖、聪明、可靠、有边界感的家庭AI伙伴。请用简短、自然、口语化的中文交流。不得自称Dots、点点或其他AI产品，不得虚构自己的开发者、所属公司或身份来源。遇到不知道的事情要坦诚说明，不要编造。${name ? `用户希望被称为${name}。` : ''}${preference ? `用户的偏好：${preference}。` : ''}`;
  async function askOpenRouter(apiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'openrouter/free',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: body.text },
          ],
          stream: false,
        }),
      });

      if (!upstream.ok) throw new Error('OpenRouter 请求失败');

      const data = await upstream.json();
      const reply = data?.choices?.[0]?.message?.content;

      if (typeof reply !== 'string' || !reply.trim()) {
        throw new Error('OpenRouter 返回内容无效');
      }

      return reply.trim().slice(0, 2000);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function askGemini(apiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: [
              {
                role: 'user',
                parts: [{ text: body.text }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 512,
            },
          }),
        }
      );

      if (!upstream.ok) throw new Error('Gemini 请求失败');

      const data = await upstream.json();
      const reply = data?.candidates?.[0]?.content?.parts
        ?.map(part => typeof part.text === 'string' ? part.text : '')
        .join('');

      if (typeof reply !== 'string' || !reply.trim()) {
        throw new Error('Gemini 返回内容无效');
      }

      return reply.trim().slice(0, 2000);
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const reply = await askOpenRouter(process.env.OPENROUTER_API_KEY);
        sendJson(response, 200, { reply });
        return;
      } catch {
        // OpenRouter 失败时，继续尝试 Gemini。
      }
    }

    if (process.env.GEMINI_API_KEY) {
      try {
        const reply = await askGemini(process.env.GEMINI_API_KEY);
        sendJson(response, 200, { reply });
        return;
      } catch {
        // 两个 AI 服务都失败时，返回统一错误。
      }
    }

    sendJson(response, 503, { error: 'AI 服务暂不可用' });
  } catch {
    sendJson(response, 502, { error: 'AI 服务暂不可用' });
  }
}

const server = createServer(async (request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  if (pathname === '/api/chat') {
    if (request.method !== 'POST') { sendJson(response, 405, { error: '方法不允许' }); return; }
    await handleChat(request, response);
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = resolve(root, relative);
  if (!file.startsWith(root + sep) && file !== resolve(root, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, '0.0.0.0', () => console.log(`家里有个AI已启动：http://localhost:${port}`));

// ===== 阿明天气查询：新增功能 =====
async function getWeatherReply(text) {
  const cityMatch = text.match(/(?:查|看|问|在)?([\u4e00-\u9fa5]{2,8}?)(?:市|县|区)?(?=(?:(?:今天|明天|后天)(?:会不会|会|可能)?|(?:会不会|会|可能)?)(?:的)?(?:天气|气温|温度|下雨|降雨|下雪))/);
  const timeWords = new Set(['今天', '明天', '后天']);
  const city = cityMatch && !timeWords.has(cityMatch[1])
    ? cityMatch[1]
    : '常州';

  const cityNames = {
    '常州': 'Changzhou',
    '南京': 'Nanjing',
    '苏州': 'Suzhou',
    '无锡': 'Wuxi',
    '上海': 'Shanghai',
    '北京': 'Beijing',
    '杭州': 'Hangzhou',
    '广州': 'Guangzhou',
    '深圳': 'Shenzhen',
    '成都': 'Chengdu',
  };
  const geoQueryName = cityNames[city] || city;

  const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.search = new URLSearchParams({
    name: geoQueryName,
    count: '10',
    language: 'zh',
    format: 'json',
  }).toString();

  const geoResponse = await fetch(geoUrl, { signal: AbortSignal.timeout(10000) });
  if (!geoResponse.ok) throw new Error('天气城市查询失败');

  const geoData = await geoResponse.json();
  const place = geoData.results?.find(item =>
    item.country_code === 'CN' &&
    (item.name === city || item.name === `${city}市` ||
     item.admin2 === city || item.admin1 === city)
  ) || geoData.results?.find(item => item.country_code === 'CN');

  if (!place) return `暂时没有查到${city}的天气信息，你可以换个城市名称再问我。`;

  const dayOffset = /后天/.test(text) ? 2 : /明天/.test(text) ? 1 : 0;
  const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
  weatherUrl.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,precipitation,rain,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: place.timezone || 'Asia/Shanghai',
    forecast_days: '3',
  }).toString();

  const weatherResponse = await fetch(weatherUrl, { signal: AbortSignal.timeout(10000) });
  if (!weatherResponse.ok) throw new Error('天气预报查询失败');

  const data = await weatherResponse.json();
  const labels = {
    0: '晴', 1: '大致晴朗', 2: '多云', 3: '阴',
    45: '有雾', 48: '有雾',
    51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
    56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '较强阵雨', 82: '强阵雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹',
  };

  const daily = data.daily;
  const date = daily.time[dayOffset];
  const max = Math.round(daily.temperature_2m_max[dayOffset]);
  const min = Math.round(daily.temperature_2m_min[dayOffset]);
  const chance = daily.precipitation_probability_max?.[dayOffset];
  const dayLabel = ['今天', '明天', '后天'][dayOffset];

  if (dayOffset === 0) {
    const current = data.current;
    const condition = labels[current.weather_code] || '天气情况多变';
    const rainNow = Number(current.rain || 0) > 0;
    const currentCondition = rainNow && [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(current.weather_code)
      ? condition
      : condition;
    const rainTip = chance >= 60 ? '，今天雨水概率较高，出门记得带伞' :
      chance >= 30 ? '，今天可能有雨，出门可以带把伞' : '';
    return `${place.name}现在${Math.round(current.temperature_2m)}℃左右，${currentCondition}。今天最高${max}℃，最低${min}℃${rainTip}。`;
  }

  const condition = labels[daily.weather_code[dayOffset]] || '天气情况多变';
  const rainTip = chance >= 60 ? `，降水概率约${chance}%，记得带伞` :
    chance >= 30 ? `，有一定降雨可能，出门可以带伞` : '';
  return `${place.name}${dayLabel}预计${condition}，最高${max}℃，最低${min}℃${rainTip}。`;
}
