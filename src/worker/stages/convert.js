const path = require('node:path');
const { runProcess } = require('./process');

async function convert(audioPath, context) {
  const wavPath = path.join(context.jobDir, 'audio.wav');
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], {
    stage: 'converting', timeoutMs: context.timeoutMs, logPath: context.logPath, onHeartbeat: context.onHeartbeat,
  });
  return wavPath;
}

module.exports = { convert };
