export function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function readJson(req, limit = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error('Invalid JSON object'), { status: 400 }); }
}

export function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  res.on('close', () => clearInterval(heartbeat));
}

export function writeSse(res, event, data) {
  if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Frames can span arbitrary TCP/UTF-8 chunks. Also accept CRLF and multiline data.
export async function* readSse(body) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const lines = frame.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield {
        event: lines.find((l) => l.startsWith('event:'))?.slice(6).trim() || 'message',
        data: JSON.parse(data),
      };
    }
    if (buffer.length > 2 * 1024 * 1024) throw new Error('Stream frame too large');
  }
}
