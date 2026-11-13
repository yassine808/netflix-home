using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace NetflixHome
{
    /// <summary>
    /// Desktop launcher for the local netflix-home app.
    ///
    /// Starts the Express server without a console window, opens the app in the
    /// default browser, and keeps a Netflix-style icon in the notification area
    /// (system tray). Clicking that icon opens the page again; its menu can
    /// reopen the app or stop the server and exit.
    /// </summary>
    internal static class Program
    {
        private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
        private static readonly string LogPath = Path.Combine(Root, "launcher.log");
        private static readonly string PortFile = Path.Combine(Root, ".cache", "port");

        private static Process server;
        private static bool ownsServer;
        private static string baseUrl = "";

        [STAThread]
        private static void Main()
        {
            bool isNew;
            using (var mutex = new Mutex(true, "Yassine.NetflixHome.Launcher", out isNew))
            {
                if (!isNew)
                {
                    // Already running: just bring the page back.
                    Log("launcher already running; opening browser only");
                    OpenApp(AttachedUrl());
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                StartServer();
                OpenApp(baseUrl);
                Log("browser opened at " + baseUrl);

                var menu = new ContextMenuStrip();
                menu.Items.Add("Open netflix-home", null, (s, e) => OpenApp(baseUrl));
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Quit (stop server)", null, (s, e) =>
                {
                    StopServer();
                    Application.Exit();
                });

                var tray = new NotifyIcon
                {
                    Text = "netflix-home - " + baseUrl,
                    Icon = LoadIcon(),
                    ContextMenuStrip = menu,
                    Visible = true
                };
                tray.MouseClick += (s, e) =>
                {
                    if (e.Button != MouseButtons.Left) return;
                    Log("tray clicked; opening browser");
                    OpenApp(baseUrl);
                };
                tray.MouseDoubleClick += (s, e) =>
                {
                    if (e.Button != MouseButtons.Left) return;
                    Log("tray double-clicked; opening browser");
                    OpenApp(baseUrl);
                };

                Log("tray icon visible");

                Application.Run(new ApplicationContext());

                tray.Visible = false;
                tray.Dispose();
                StopServer();
                GC.KeepAlive(mutex);
            }
        }

        private static Icon LoadIcon()
        {
            string path = Path.Combine(Root, "public", "favicon.ico");
            try
            {
                if (File.Exists(path)) return new Icon(path, SystemInformation.SmallIconSize);
                Log("icon missing at " + path);
            }
            catch (Exception ex)
            {
                Log("icon failed: " + ex.Message);
            }
            return SystemIcons.Application;
        }

        private static void StartServer()
        {
            // A previous instance (or npm start) may already be serving. The
            // server records its port in .cache/port.
            int attached = SavedPort();
            if (attached > 0 && PortOpen(attached) && LooksLikeApp(attached))
            {
                baseUrl = "http://localhost:" + attached;
                Log("port " + attached + " already served; attaching without starting a new server");
                return;
            }

            // Anything sitting on the old port is not this app; drop the stale
            // record so the wait loop only accepts a port the new server writes.
            try { File.Delete(PortFile); } catch { }

            try
            {
                var info = new ProcessStartInfo("node", "server/index.js")
                {
                    WorkingDirectory = Root,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                info.EnvironmentVariables.Remove("PORT");
                server = Process.Start(info);
                ownsServer = server != null;
                if (server != null) Log("server started (pid " + server.Id + ")");

                server.OutputDataReceived += (s, e) =>
                {
                    string line = e.Data;
                    if (string.IsNullOrWhiteSpace(line)) return;
                    var match = System.Text.RegularExpressions.Regex.Match(
                        line, @"running at http://localhost:(\d+)");
                    if (match.Success)
                    {
                        baseUrl = "http://localhost:" + match.Groups[1].Value;
                        Log("server url: " + baseUrl);
                    }
                };
                server.BeginOutputReadLine();
                server.ErrorDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrWhiteSpace(e.Data)) Log("node: " + e.Data);
                };
                server.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                Log("could not start node: " + ex.Message);
                MessageBox.Show(
                    "Node.js was not found on PATH. Install Node, then start the launcher again.",
                    "netflix-home", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.Exit(1);
            }

            // The server picks a free port itself (3000, then a random high
            // port). Wait until it either reports one or the port file lands.
            DateTime deadline = DateTime.UtcNow.AddSeconds(45);
            int port = 0;
            while (port <= 0)
            {
                if (server.HasExited)
                {
                    Log("server exited before listening");
                    MessageBox.Show(
                        "The server exited before it started listening. See launcher.log.",
                        "netflix-home", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Environment.Exit(1);
                }
                port = ParsedPort(baseUrl);
                if (port <= 0)
                {
                    int saved = SavedPort();
                    if (saved > 0 && LooksLikeApp(saved)) port = saved;
                }
                if (port > 0 && !PortOpen(port)) port = 0;
                if (DateTime.UtcNow > deadline)
                {
                    Log("timed out waiting for the server");
                    port = SavedPort();
                    break;
                }
                Thread.Sleep(250);
            }

            if (port > 0) baseUrl = "http://localhost:" + port;
            if (baseUrl.Length == 0)
            {
                int saved = SavedPort();
                baseUrl = saved > 0 ? "http://localhost:" + saved : "http://localhost:3000";
            }
            Log("server listening on " + baseUrl);
        }

        private static int ParsedPort(string url)
        {
            var match = System.Text.RegularExpressions.Regex.Match(url, @":(\d+)$");
            int port;
            return match.Success && int.TryParse(match.Groups[1].Value, out port) ? port : 0;
        }

        private static int SavedPort()
        {
            try
            {
                if (!File.Exists(PortFile)) return 0;
                int port;
                return int.TryParse(File.ReadAllText(PortFile).Trim(), out port) && port > 0 ? port : 0;
            }
            catch
            {
                return 0;
            }
        }

        private static string AttachedUrl()
        {
            int port = SavedPort();
            if (port > 0) return "http://localhost:" + port;
            return baseUrl.Length > 0 ? baseUrl : "http://localhost:3000";
        }

        private static void StopServer()
        {
            if (!ownsServer || server == null || server.HasExited) return;
            try
            {
                var kill = Process.Start(new ProcessStartInfo("taskkill", "/PID " + server.Id + " /T /F")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                if (kill != null) kill.WaitForExit(10000);
                Log("server stopped (pid " + server.Id + ")");
            }
            catch (Exception ex)
            {
                Log("could not stop server: " + ex.Message);
            }
        }

        private static bool PortOpen(int port)
        {
            using (var client = new TcpClient())
            {
                try
                {
                    var task = client.ConnectAsync("127.0.0.1", port);
                    return task.Wait(400) && client.Connected;
                }
                catch
                {
                    return false;
                }
            }
        }

        // A port can be busy without being this app (another dev server, a
        // stale process). Only attach when /api/library answers.
        private static bool LooksLikeApp(int port)
        {
            try
            {
                var request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(
                    "http://localhost:" + port + "/api/library");
                request.Method = "GET";
                request.Timeout = 2000;
                using (var response = (System.Net.HttpWebResponse)request.GetResponse())
                {
                    return (int)response.StatusCode == 200;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void OpenApp(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Log("could not open browser: " + ex.Message);
            }
        }

        private static void Log(string message)
        {
            try
            {
                File.AppendAllText(
                    LogPath,
                    "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine);
            }
            catch
            {
                // logging must never break the launcher
            }
        }
    }
}
