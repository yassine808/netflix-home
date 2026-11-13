/* Stand-in for ffmpeg-static inside the single-file build: the real ffmpeg.exe
 * ships inside the exe and is extracted to <library>\.cache\app\bin at startup. */
export default process.env.FFMPEG_PATH || 'ffmpeg';