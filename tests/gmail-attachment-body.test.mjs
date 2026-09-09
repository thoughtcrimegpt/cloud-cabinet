import test from 'node:test';
import assert from 'node:assert/strict';
import { readAttachmentBody, MAX_GMAIL_ATTACHMENT } from '../src/gmail-attachment-body.ts';

function chunked(text, size=3) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i=0;i<bytes.length;i+=size) controller.enqueue(bytes.slice(i,i+size));
      controller.close();
    },
  }), { headers:{'content-type':'application/json'} });
}

test('attachment decoder handles chunk boundaries and URL-safe base64', async () => {
  const raw = new TextEncoder().encode('chunked Gmail attachment ✓');
  const data = btoa(String.fromCharCode(...raw)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const out = await readAttachmentBody(chunked(`{"size":${raw.length},"data":"${data}"}`,2),raw.length);
  assert.deepEqual(out,raw);
});

test('attachment decoder rejects corruption, duplicate fields, truncation, and size mismatch', async () => {
  for (const [json,size] of [
    ['{"size":3,"data":"a!="}',3],
    ['{"size":1,"size":1,"data":"YQ"}',1],
    ['{"size":2,"data":"YQ"}',2],
    ['{"size":2,"data":"YQ"}',1],
  ]) await assert.rejects(readAttachmentBody(new Response(json),size));
});

test('attachment decoder enforces the 20 MiB bound before allocation', async () => {
  await assert.rejects(readAttachmentBody(Response.json({size:MAX_GMAIL_ATTACHMENT+1,data:''}),MAX_GMAIL_ATTACHMENT+1), /Attachment unavailable/);
  await assert.rejects(readAttachmentBody(new Response('{"size":1,"data":"YQ=="}',{headers:{'content-length':'999999'}}),1), /response too large/i);
});

test('attachment decoder accepts a valid attachment at exactly 20 MiB', async () => {
  const raw = new Uint8Array(MAX_GMAIL_ATTACHMENT);
  raw.fill(65);
  let encoded = '';
  for (let i=0;i<raw.length;i+=24576) encoded += btoa(String.fromCharCode(...raw.subarray(i,i+24576)));
  const out = await readAttachmentBody(new Response(`{"size":${raw.length},"data":"${encoded}"}`),raw.length);
  assert.equal(out.byteLength,MAX_GMAIL_ATTACHMENT);
  assert.equal(out[0],65);
  assert.equal(out[out.length-1],65);
});
