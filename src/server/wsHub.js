import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;

  if (length < 126) {
    const header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
    return Buffer.concat([header, data]);
  }

  if (length < 65536) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, data]);
  }

  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, data]);
}

function decodeFrames(buffer) {
  let offset = 0;
  const frames = [];

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];

    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { frames, remaining: Buffer.alloc(0), protocolError: true };
      }
      payloadLength = Number(longLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const totalLength = headerLength + maskLength + payloadLength;
    if (offset + totalLength > buffer.length) {
      break;
    }

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + totalLength);

    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.allocUnsafe(payloadLength);
      for (let i = 0; i < payloadLength; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    frames.push({ opcode, payload });
    offset += totalLength;
  }

  return {
    frames,
    remaining: buffer.subarray(offset),
    protocolError: false
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class WebSocketHub {
  constructor({ engine, publishIntervalMs }) {
    this.engine = engine;
    this.publishIntervalMs = publishIntervalMs;
    this.clients = new Set();
    this.publishTimer = null;
  }

  attach(server) {
    server.on("upgrade", (request, socket) => {
      if (!request.url || !request.url.startsWith("/ws")) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const websocketKey = request.headers["sec-websocket-key"];
      if (!websocketKey) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const acceptKey = createHash("sha1")
        .update(`${websocketKey}${WS_GUID}`)
        .digest("base64");

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${acceptKey}`,
          "\r\n"
        ].join("\r\n")
      );

      socket.setNoDelay(true);

      const client = {
        socket,
        buffer: Buffer.alloc(0),
        filters: {
          assetClass: "ALL",
          desk: "ALL",
          trader: "ALL",
          timeframe: "15m"
        }
      };

      this.clients.add(client);
      this.send(client, {
        type: "connection",
        status: "ok",
        timestamp: Date.now(),
        meta: this.engine.getMeta()
      });
      this.send(client, {
        type: "snapshot",
        payload: this.engine.getSnapshot(client.filters)
      });

      socket.on("data", (chunk) => this.handleData(client, chunk));
      socket.on("close", () => this.clients.delete(client));
      socket.on("error", () => this.clients.delete(client));
    });
  }

  start() {
    if (this.publishTimer) {
      return;
    }

    this.publishTimer = setInterval(() => {
      if (this.clients.size === 0) {
        return;
      }

      const cache = new Map();
      for (const client of this.clients) {
        if (client.socket.destroyed) {
          this.clients.delete(client);
          continue;
        }

        const key = `${client.filters.assetClass}|${client.filters.desk}|${client.filters.trader}|${client.filters.timeframe}`;
        let serialized = cache.get(key);

        if (!serialized) {
          const snapshot = this.engine.getSnapshot(client.filters);
          serialized = JSON.stringify({
            type: "snapshot",
            payload: snapshot
          });
          cache.set(key, serialized);
        }

        client.socket.write(encodeFrame(serialized));
      }
    }, this.publishIntervalMs);
  }

  stop() {
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }

    for (const client of this.clients) {
      if (!client.socket.destroyed) {
        client.socket.end();
      }
    }

    this.clients.clear();
  }

  handleData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    const decoded = decodeFrames(client.buffer);

    if (decoded.protocolError) {
      client.socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      this.clients.delete(client);
      return;
    }

    client.buffer = decoded.remaining;

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        client.socket.end(encodeFrame(Buffer.alloc(0), 0x8));
        this.clients.delete(client);
        return;
      }

      if (frame.opcode === 0x9) {
        client.socket.write(encodeFrame(frame.payload, 0x0a));
        continue;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      const message = safeJsonParse(frame.payload.toString("utf8"));
      if (!message || typeof message !== "object") {
        continue;
      }

      if (message.type === "subscribe" && message.filters) {
        const nextFilters = {
          assetClass: message.filters.assetClass || "ALL",
          desk: message.filters.desk || "ALL",
          trader: message.filters.trader || "ALL",
          timeframe: message.filters.timeframe || "15m"
        };

        client.filters = nextFilters;
        this.send(client, {
          type: "snapshot",
          payload: this.engine.getSnapshot(client.filters)
        });
      }
    }
  }

  send(client, payload) {
    if (client.socket.destroyed) {
      return;
    }
    client.socket.write(encodeFrame(JSON.stringify(payload)));
  }
}
