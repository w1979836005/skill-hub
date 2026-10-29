// Mock SSE server: emits N deltas with a fixed gap so we can verify the meter's math.
import http from 'node:http';

const GAP = 25;        // ms between deltas
const TTFT = 200;      // ms before first delta
const N = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST') return res.writeHead(404).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const anthropic = req.url.includes('/messages');

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    const batch = req.url.includes('batch');

    await sleep(TTFT);
    for (let i = 0; i < N; i++) {
      if (batch) {
        // emit 8 events at once, then stall: exactly what a buffering proxy does
        for (let k = 0; k < 8 && i < N; k++, i++) {
          send({ choices: [{ index: 0, delta: { content: '汉字' } }] });
        }
        await sleep(GAP * 8);
        continue;
      }
      if (anthropic) {
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '汉字' },
        });
      } else {
        send({ choices: [{ index: 0, delta: { content: '汉字' } }] });
      }
      if (i < N - 1) await sleep(GAP);
    }
    if (anthropic) {
      send({ type: 'message_delta', delta: {}, usage: { output_tokens: N } });
    } else if (body.stream_options?.include_usage) {
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: N } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  })
  .listen(18080, () => console.log('mock on http://127.0.0.1:18080'));
