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
        private const string Url = "http://localhost:3000";
        private const int Port = 3000;

        private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
        private static readonly string LogPath = Path.Combine(Root, "launcher.log");

        private static Process server;
        private static bool ownsServer;

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
                    OpenApp();
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                StartServer();
                OpenApp();
                Log("browser opened");

                var menu = new ContextMenuStrip();
                menu.Items.Add("Open netflix-home", null, (s, e) => OpenApp());
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Quit (stop server)", null, (s, e) =>
                {
                    StopServer();
                    Application.Exit();
                });

                var tray = new NotifyIcon
                {
                    Text = "netflix-home - " + Url,
                    Icon = LoadIcon(),
                    ContextMenuStrip = menu,
                    Visible = true
                };
                tray.MouseClick += (s, e) =>
                {
                    if (e.Button != MouseButtons.Left) return;
                    Log("tray clicked; opening browser");
                    OpenApp();
                };
                tray.MouseDoubleClick += (s, e) =>
                {
                    if (e.Button != MouseButtons.Left) return;
                    Log("tray double-clicked; opening browser");
                    OpenApp();
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
            if (PortOpen(Port))
            {
                Log("port " + Port + " already served; attaching without starting a new server");
                return;
            }

            try
            {
                var info = new ProcessStartInfo("node", "server/index.js")
                {
                    WorkingDirectory = Root,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                info.EnvironmentVariables["PORT"] = Port.ToString();
                server = Process.Start(info);
                ownsServer = server != null;
                if (server != null) Log("server started (pid " + server.Id + ") on port " + Port);
            }
            catch (Exception ex)
            {
                Log("could not start node: " + ex.Message);
                MessageBox.Show(
                    "Node.js was not found on PATH. Install Node, then start the launcher again.",
                    "netflix-home", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.Exit(1);
            }

            DateTime deadline = DateTime.UtcNow.AddSeconds(45);
            while (!PortOpen(Port))
            {
                if (server.HasExited)
                {
                    Log("server exited before listening");
                    MessageBox.Show(
                        "The server exited before it started listening. See launcher.log.",
                        "netflix-home", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Environment.Exit(1);
                }
                if (DateTime.UtcNow > deadline)
                {
                    Log("timed out waiting for the server");
                    break;
                }
                Thread.Sleep(300);
            }
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

        private static void OpenApp()
        {
            try
            {
                Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
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
