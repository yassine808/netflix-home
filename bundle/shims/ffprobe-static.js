/* Stand-in for ffprobe-static inside the single-file build: the real
 * ffprobe.exe ships inside the exe and is extracted with ffmpeg at startup. */
export default { path: process.env.FFPROBE_PATH || 'ffprobe' };