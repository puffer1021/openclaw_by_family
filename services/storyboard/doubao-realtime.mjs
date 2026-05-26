/**
 * 豆包 Realtime S2S（端到端实时语音）二进制协议封装
 * https://www.volcengine.com/docs/6561/1257544
 *
 * 帧结构（最简化版本，不开 gzip / 不带 connect/error code）：
 *   byte0: 0b00010001  protocol_v=1 / header_size=1
 *   byte1: <message_type><msg_flags>
 *   byte2: <serialization><compression>   serialization: 0=raw 1=json   compression: 0=none
 *   byte3: 0
 *   [optional] sequence (4 bytes)        当 msg_flags 含 sequence bit
 *   [optional] event id (4 bytes)        当 msg_flags 含 event bit (0b0100)
 *   [optional] session_id_size (4) + bytes  session 类事件必带
 *   payload_size (4) + payload
 *
 * 我们只用 event-based 帧（msg_flags = 0b0100）。
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const RESOURCE_ID = "volc.speech.dialog";
const APP_KEY = "PlgvMymc7f3tQnJ6"; // 豆包文档里写死

// Message Type (high 4 bits of byte1)
const MT_FULL_CLIENT = 0b0001;
const MT_FULL_SERVER = 0b1001;
const MT_AUDIO_REQ   = 0b0010;
const MT_AUDIO_RESP  = 0b1011;
const MT_ERROR       = 0b1111;

// Message Flags (low 4 bits of byte1)
const FLAG_EVENT = 0b0100;
const FLAG_ERROR = 0b1111;

// Serialization (high 4 bits of byte2)
const SER_RAW  = 0b0000;
const SER_JSON = 0b0001;

// Client event IDs
export const EVT = {
  StartConnection:  1,
  FinishConnection: 2,
  StartSession:     100,
  FinishSession:    102,
  TaskRequest:      200,
  SayHello:         300,
  ChatTTSText:      500,
  ClientInterrupt:  515,
};

// Server event IDs（部分）
export const SRV = {
  ConnectionStarted:  50,
  ConnectionFailed:   51,
  ConnectionFinished: 52,
  SessionStarted:    150,
  SessionFinished:   152,
  SessionFailed:     153,
  TTSSentenceStart:  350,
  TTSSentenceEnd:    351,
  TTSResponse:       352,
  TTSEnded:          359,
  ASRInfo:           450,
  ASRResponse:       451,
  ASREnded:          459,
  ChatResponse:      550,
  ChatEnded:         559,
  DialogCommonError: 599,
};

// 构造一个 event 类二进制帧
function buildFrame({ messageType, serialization, eventId, sessionId, payload }) {
  const header = Buffer.alloc(4);
  header[0] = (1 << 4) | 1; // version=1, header_size=1
  header[1] = (messageType << 4) | FLAG_EVENT;
  header[2] = (serialization << 4) | 0;
  header[3] = 0;

  const evtBuf = Buffer.alloc(4);
  evtBuf.writeInt32BE(eventId, 0);

  let sessionPart = Buffer.alloc(0);
  if (sessionId) {
    const sidBytes = Buffer.from(sessionId, "utf8");
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeInt32BE(sidBytes.length, 0);
    sessionPart = Buffer.concat([sizeBuf, sidBytes]);
  }

  const payloadBuf = payload ?? Buffer.alloc(0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeInt32BE(payloadBuf.length, 0);

  return Buffer.concat([header, evtBuf, sessionPart, sizeBuf, payloadBuf]);
}

// 解析服务端帧
function parseFrame(buf) {
  if (buf.length < 4) return null;
  const messageType = (buf[1] >> 4) & 0x0f;
  const msgFlags = buf[1] & 0x0f;
  const serialization = (buf[2] >> 4) & 0x0f;

  let off = 4;
  const result = { messageType, serialization, payload: null, eventId: null, sessionId: null };

  if (msgFlags === FLAG_ERROR) {
    if (buf.length < off + 4) return null;
    result.code = buf.readInt32BE(off);
    off += 4;
  } else if ((msgFlags & FLAG_EVENT) === FLAG_EVENT) {
    if (buf.length < off + 4) return null;
    result.eventId = buf.readInt32BE(off);
    off += 4;
    // session 类事件（150-199 / 250-299 / 350-399 等）会带 session id
    // 简单做法：尝试解 session_id，长度合理就视作有
    if (buf.length >= off + 4) {
      const possibleSize = buf.readInt32BE(off);
      if (possibleSize >= 0 && possibleSize <= 256 && buf.length >= off + 4 + possibleSize + 4) {
        result.sessionId = buf.slice(off + 4, off + 4 + possibleSize).toString("utf8");
        off += 4 + possibleSize;
      }
    }
  }

  if (buf.length < off + 4) return result;
  const payloadSize = buf.readInt32BE(off);
  off += 4;
  if (buf.length < off + payloadSize) return result;
  const raw = buf.slice(off, off + payloadSize);

  if (serialization === SER_JSON) {
    try { result.payload = JSON.parse(raw.toString("utf8")); }
    catch { result.payload = raw.toString("utf8"); }
  } else {
    result.payload = raw; // 二进制（音频）
  }
  return result;
}

/**
 * 开一个豆包 Realtime 会话。
 *
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.accessKey
 * @param {string} opts.systemRole - 角色描述（小猫人设之类）
 * @param {string} opts.botName - 机器人名字
 * @param {string} opts.speakingStyle - 说话风格
 * @param {string} opts.speaker - 音色（zh_female_vv_jupiter_bigtts 等）
 * @param {(event: {type: string, ...}) => void} opts.onEvent
 *   事件回调，type 包括："session_started" / "asr_partial" / "asr_final" / "asr_ended" /
 *   "chat_text" / "chat_ended" / "tts_audio" (Buffer pcm) / "tts_ended" / "error" / "closed"
 */
export function startDoubaoSession(opts) {
  const { appId, accessKey, systemRole, botName, speakingStyle, speaker, onEvent } = opts;
  if (!appId || !accessKey) throw new Error("missing appId/accessKey");

  const connectId = randomUUID();
  const sessionId = randomUUID();

  const ws = new WebSocket(URL, {
    headers: {
      "X-Api-App-ID": appId,
      "X-Api-Access-Key": accessKey,
      "X-Api-Resource-Id": RESOURCE_ID,
      "X-Api-App-Key": APP_KEY,
      "X-Api-Connect-Id": connectId,
    },
  });
  ws.binaryType = "arraybuffer";

  let started = false;
  let stopped = false;

  function safe(fn) { try { fn(); } catch (err) { console.warn("[doubao] handler err", err); } }

  function sendJson(eventId, obj, withSession = false) {
    const payload = Buffer.from(JSON.stringify(obj || {}), "utf8");
    const frame = buildFrame({
      messageType: MT_FULL_CLIENT,
      serialization: SER_JSON,
      eventId,
      sessionId: withSession ? sessionId : null,
      payload,
    });
    ws.send(frame);
  }

  function sendAudio(int16Buf) {
    const frame = buildFrame({
      messageType: MT_AUDIO_REQ,
      serialization: SER_RAW,
      eventId: EVT.TaskRequest,
      sessionId,
      payload: int16Buf,
    });
    ws.send(frame);
  }

  ws.on("open", () => {
    sendJson(EVT.StartConnection, {});
  });

  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const frame = parseFrame(buf);
    if (!frame) return;

    if (frame.messageType === MT_ERROR || (frame.payload && frame.payload.error)) {
      console.warn("[doubao] error frame", frame.code, frame.payload);
      safe(() => onEvent({ type: "error", code: frame.code, payload: frame.payload }));
      return;
    }

    switch (frame.eventId) {
      case SRV.ConnectionStarted:
        // 连接握手成功，开会话
        sendJson(EVT.StartSession, {
          tts: { audio_config: { channel: 1, format: "pcm_s16le", sample_rate: 24000 }, speaker },
          asr: { extra: {} },
          dialog: {
            bot_name: botName || "小喵",
            system_role: systemRole || "",
            speaking_style: speakingStyle || "",
            // input_mod 不设 = 默认麦克风实时模式；keep_alive 容忍中间静音
            extra: { input_mod: "keep_alive", model: "1.2.1.1" },
          },
        }, true);
        break;
      case SRV.SessionStarted: {
        started = true;
        safe(() => onEvent({ type: "session_started", payload: frame.payload }));
        // 让小喵主动打招呼。豆包 SayHello 不发 chat_text，只发 TTS，
        // 所以前端拿不到文字。我们这里同时模拟一个 chat_text+chat_ended 给前端，气泡出得来。
        const HELLO = "喵～小朋友你好呀！今天想跟我聊点什么？";
        try { sendJson(EVT.SayHello, { content: HELLO }, true); } catch {}
        safe(() => onEvent({ type: "chat_text", text: HELLO }));
        safe(() => onEvent({ type: "chat_ended" }));
        break;
      }
      case SRV.ASRInfo:
        // 用户说话开始 → 通知前端打断 TTS
        safe(() => onEvent({ type: "asr_started", payload: frame.payload }));
        break;
      case SRV.ASRResponse: {
        const r = frame.payload?.results?.[0];
        if (r) {
          safe(() => onEvent({
            type: r.is_interim ? "asr_partial" : "asr_final",
            text: r.text || "",
          }));
        }
        break;
      }
      case SRV.ASREnded:
        safe(() => onEvent({ type: "asr_ended" }));
        break;
      case SRV.ChatResponse:
        safe(() => onEvent({ type: "chat_text", text: frame.payload?.content || "" }));
        break;
      case SRV.ChatEnded:
        safe(() => onEvent({ type: "chat_ended" }));
        break;
      case SRV.TTSSentenceStart:
        safe(() => onEvent({ type: "tts_sentence_start", payload: frame.payload }));
        break;
      case SRV.TTSResponse:
        // payload 是 24k 16bit PCM 二进制
        if (Buffer.isBuffer(frame.payload)) {
          safe(() => onEvent({ type: "tts_audio", pcm: frame.payload }));
        }
        break;
      case SRV.TTSEnded:
        safe(() => onEvent({ type: "tts_ended", payload: frame.payload }));
        break;
      case SRV.SessionFinished:
      case SRV.ConnectionFinished:
        stopped = true;
        try { ws.close(); } catch {}
        break;
      case SRV.SessionFailed:
      case SRV.ConnectionFailed:
      case SRV.DialogCommonError:
        safe(() => onEvent({ type: "error", payload: frame.payload }));
        break;
      default:
        // 未知 event，记录但不报错
        // console.log("[doubao] unhandled event", frame.eventId);
        break;
    }
  });

  ws.on("error", (err) => {
    console.warn("[doubao] ws error", err.message);
    safe(() => onEvent({ type: "error", payload: { error: err.message } }));
  });

  ws.on("close", () => {
    safe(() => onEvent({ type: "closed" }));
  });

  return {
    sendAudio,
    interrupt() {
      // ClientInterrupt 仅 push_to_talk 模式生效；server VAD 模式无需主动打断
      sendJson(EVT.ClientInterrupt, {}, true);
    },
    finish() {
      if (stopped) return;
      stopped = true;
      try { sendJson(EVT.FinishSession, {}, true); } catch {}
      setTimeout(() => {
        try { sendJson(EVT.FinishConnection, {}); } catch {}
        setTimeout(() => { try { ws.close(); } catch {} }, 200);
      }, 200);
    },
    isOpen: () => ws.readyState === WebSocket.OPEN && started,
  };
}
