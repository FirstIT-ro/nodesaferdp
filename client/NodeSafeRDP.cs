// NodeSafeRDP Windows agent.
// Runs as a normal (non-administrator) user. Connects OUT to the server over HTTPS (port 443):
//   1) WebSocket (wss://)  -> lowest latency
//   2) HTTPS long-polling  -> fallback that works through proxies that break WebSockets
// Written in C# 5 so it compiles with the csc.exe that ships with Windows
// (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe) or via PowerShell Add-Type.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace NodeSafeRDP
{
    public static class Program
    {
        public const string Version = "1.0.0";

        [STAThread]
        public static int Main(string[] args)
        {
            Native.EnableDpiAwareness();
            Console.Title = "NodeSafeRDP agent";
            Log.Info("NodeSafeRDP agent " + Version + " (runs without administrator rights)");

            Config cfg;
            try
            {
                cfg = Config.Load(args);
            }
            catch (Exception e)
            {
                Log.Error(e.Message);
                Config.PrintUsage();
                return 2;
            }
            if (cfg == null) return 0; // a setup-only command completed

            bool createdNew;
            using (Mutex m = new Mutex(true, "Local\\NodeSafeRDP-Agent", out createdNew))
            {
                if (!createdNew)
                {
                    Log.Error("Another NodeSafeRDP agent is already running in this Windows session.");
                    return 3;
                }
                Net.Init(cfg);
                Log.Info("Machine name: " + cfg.Name + "   id: " + cfg.Id);
                Log.Info("Server: " + cfg.Server + "   transport: " + cfg.Transport);
                Log.Info("This window shows when someone is viewing this computer. Close it to stop remote access.");
                new Agent(cfg).RunForever();
            }
            return 0;
        }
    }

    // ------------------------------------------------------------------------------------
    static class Log
    {
        static readonly object Gate = new object();
        static void Write(string level, string msg, ConsoleColor color)
        {
            lock (Gate)
            {
                ConsoleColor old = Console.ForegroundColor;
                Console.ForegroundColor = color;
                Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + " " + level + " " + msg);
                Console.ForegroundColor = old;
            }
        }
        public static void Info(string m) { Write("INFO ", m, ConsoleColor.Gray); }
        public static void Warn(string m) { Write("WARN ", m, ConsoleColor.Yellow); }
        public static void Error(string m) { Write("ERROR", m, ConsoleColor.Red); }
        public static void Notice(string m) { Write("*****", m, ConsoleColor.Cyan); }
    }

    // ------------------------------------------------------------------------------------
    // Configuration: %APPDATA%\NodeSafeRDP\agent.json (key encrypted with DPAPI for this user)
    // ------------------------------------------------------------------------------------
    public class Config
    {
        public string Server;          // https://rdp.example.com
        public string Key;             // agent enrollment key from the server
        public string Name;            // display name
        public string Id;              // stable random id for this machine+user
        public string Transport = "auto"; // auto | websocket | poll
        public string Proxy = "system";   // system | none | http://host:port
        public bool AllowHttp;         // only for local testing

        static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NodeSafeRDP"); } }
        static string DefaultFile { get { return Path.Combine(Dir, "agent.json"); } }

        public static void PrintUsage()
        {
            Console.WriteLine(@"
Usage:
  NodeSafeRDP.exe --setup --server https://rdp.example.com --key <AGENT_KEY> [--name ""My PC""]
        Save settings for this Windows user (key is encrypted with Windows DPAPI) and exit.
  NodeSafeRDP.exe
        Run with saved settings (asks for them the first time).
Options:
  --server URL        Server address (https://...)
  --key KEY           Agent key printed by the server installer
  --name NAME         Name shown in the web console (default: computer name)
  --transport MODE    auto (default) | websocket | poll
  --proxy VALUE       system (default) | none | http://proxy:port
  --config FILE       Use a specific JSON config file
  --autostart on|off  Start automatically at logon for this user (HKCU, no admin needed)
  --allow-http        Allow http:// server URL (local testing only)");
        }

        public static Config Load(string[] args)
        {
            Dictionary<string, string> a = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < args.Length; i++)
            {
                string k = args[i];
                if (!k.StartsWith("--")) throw new ArgumentException("Unexpected argument: " + k);
                k = k.Substring(2);
                if (k == "setup" || k == "allow-http" || k == "help") { a[k] = "1"; continue; }
                if (i + 1 >= args.Length) throw new ArgumentException("Missing value for --" + k);
                a[k] = args[++i];
            }
            if (a.ContainsKey("help")) { PrintUsage(); return null; }

            if (a.ContainsKey("autostart"))
            {
                SetAutostart(a["autostart"] == "on");
                return null;
            }

            string file = a.ContainsKey("config") ? a["config"] : DefaultFile;
            Config c = File.Exists(file) ? Read(file) : new Config();
            if (a.ContainsKey("server")) c.Server = a["server"];
            if (a.ContainsKey("key")) c.Key = a["key"];
            if (a.ContainsKey("name")) c.Name = a["name"];
            if (a.ContainsKey("transport")) c.Transport = a["transport"];
            if (a.ContainsKey("proxy")) c.Proxy = a["proxy"];
            if (a.ContainsKey("allow-http")) c.AllowHttp = true;

            bool interactive = false;
            if (string.IsNullOrEmpty(c.Server))
            {
                Console.Write("Server URL (e.g. https://rdp.example.com): ");
                c.Server = (Console.ReadLine() ?? "").Trim();
                interactive = true;
            }
            if (string.IsNullOrEmpty(c.Key))
            {
                Console.Write("Agent key: ");
                c.Key = ReadHidden();
                interactive = true;
            }
            if (string.IsNullOrEmpty(c.Name)) c.Name = Environment.MachineName;
            if (string.IsNullOrEmpty(c.Id)) c.Id = Guid.NewGuid().ToString("N");
            c.Server = (c.Server ?? "").Trim().TrimEnd('/');
            c.Transport = (c.Transport ?? "auto").ToLowerInvariant();

            Uri u;
            if (!Uri.TryCreate(c.Server, UriKind.Absolute, out u) || (u.Scheme != "https" && !(u.Scheme == "http" && c.AllowHttp)))
                throw new ArgumentException("Server must be an https:// URL (got '" + c.Server + "')");
            if (c.Transport != "auto" && c.Transport != "websocket" && c.Transport != "poll")
                throw new ArgumentException("--transport must be auto, websocket or poll");
            if (string.IsNullOrEmpty(c.Key)) throw new ArgumentException("Agent key is required");

            if (a.ContainsKey("setup") || interactive || !File.Exists(file))
            {
                c.Save(file);
                Log.Info("Settings saved to " + file);
            }
            if (a.ContainsKey("setup")) return null;
            return c;
        }

        static string ReadHidden()
        {
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                ConsoleKeyInfo k = Console.ReadKey(true);
                if (k.Key == ConsoleKey.Enter) break;
                if (k.Key == ConsoleKey.Backspace) { if (sb.Length > 0) sb.Length--; continue; }
                sb.Append(k.KeyChar);
            }
            Console.WriteLine();
            return sb.ToString().Trim();
        }

        static Config Read(string file)
        {
            Dictionary<string, object> d = Json.Parse(File.ReadAllText(file));
            Config c = new Config();
            c.Server = Json.Str(d, "server");
            c.Name = Json.Str(d, "name");
            c.Id = Json.Str(d, "id");
            c.Transport = Json.Str(d, "transport") ?? "auto";
            c.Proxy = Json.Str(d, "proxy") ?? "system";
            c.AllowHttp = Json.Bool(d, "allowHttp");
            string prot = Json.Str(d, "keyProtected");
            if (!string.IsNullOrEmpty(prot))
            {
                try
                {
                    byte[] raw = ProtectedData.Unprotect(Convert.FromBase64String(prot), Entropy, DataProtectionScope.CurrentUser);
                    c.Key = Encoding.UTF8.GetString(raw);
                }
                catch { Log.Warn("Saved key could not be decrypted (different Windows user?)"); }
            }
            if (string.IsNullOrEmpty(c.Key)) c.Key = Json.Str(d, "key"); // plain key (e.g. provided by an admin file)
            return c;
        }

        static readonly byte[] Entropy = Encoding.UTF8.GetBytes("NodeSafeRDP-agent-key");

        void Save(string file)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
            string prot = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(Key), Entropy, DataProtectionScope.CurrentUser));
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["server"] = Server;
            d["name"] = Name;
            d["id"] = Id;
            d["transport"] = Transport;
            d["proxy"] = Proxy;
            if (AllowHttp) d["allowHttp"] = true;
            d["keyProtected"] = prot;
            File.WriteAllText(file, Json.Write(d));
        }

        static void SetAutostart(bool on)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                string launcher = Environment.GetEnvironmentVariable("NSR_LAUNCH_COMMAND");
                if (string.IsNullOrEmpty(launcher)) launcher = "\"" + Process.GetCurrentProcess().MainModule.FileName + "\"";
                if (on) { k.SetValue("NodeSafeRDP", launcher); Log.Info("Autostart enabled: " + launcher); }
                else { k.DeleteValue("NodeSafeRDP", false); Log.Info("Autostart disabled"); }
            }
        }
    }

    // ------------------------------------------------------------------------------------
    static class Json
    {
        static readonly JavaScriptSerializer S = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        public static Dictionary<string, object> Parse(string s)
        {
            return S.Deserialize<Dictionary<string, object>>(s);
        }
        public static string Write(object o) { return S.Serialize(o); }
        public static string Str(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) : null;
        }
        public static double Num(Dictionary<string, object> d, string k, double def)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return def; }
        }
        public static bool Bool(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
    }

    // ------------------------------------------------------------------------------------
    // Networking defaults: modern TLS, Windows certificate store, system proxy.
    // A transparent (iptables-redirect) proxy needs no configuration at all: we only make
    // ordinary outbound HTTPS connections on port 443. If that proxy inspects TLS, its root
    // certificate must be trusted by Windows (normally deployed by IT); we use the Windows store.
    // ------------------------------------------------------------------------------------
    static class Net
    {
        public static IWebProxy Proxy;

        public static void Init(Config cfg)
        {
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; }
            catch (NotSupportedException) { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }
            ServicePointManager.Expect100Continue = false;   // many proxies mishandle 100-continue
            ServicePointManager.UseNagleAlgorithm = false;
            ServicePointManager.DefaultConnectionLimit = 16;

            if (cfg.Proxy == "none") Proxy = null;
            else if (cfg.Proxy == "system" || string.IsNullOrEmpty(cfg.Proxy)) Proxy = WebRequest.GetSystemWebProxy();
            else Proxy = new WebProxy(cfg.Proxy);
            if (Proxy != null) Proxy.Credentials = CredentialCache.DefaultCredentials; // NTLM/Kerberos proxy auth
            WebRequest.DefaultWebProxy = Proxy;
        }
    }

    // ------------------------------------------------------------------------------------
    // Transports
    // ------------------------------------------------------------------------------------
    interface ITransport : IDisposable
    {
        string Name { get; }
        void Connect(Dictionary<string, object> hello);       // throws on failure
        void SendFrame(byte[] frame);                           // blocks until server ack
        void SendJson(Dictionary<string, object> msg);
        bool Alive { get; }
        event Action<Dictionary<string, object>> Command;
    }

    class WsTransport : ITransport
    {
        readonly Uri uri;
        ClientWebSocket ws;
        readonly object sendLock = new object();
        readonly AutoResetEvent ack = new AutoResetEvent(false);
        readonly ManualResetEvent welcome = new ManualResetEvent(false);
        volatile bool alive;
        public event Action<Dictionary<string, object>> Command;
        public string Name { get { return "websocket"; } }
        public bool Alive { get { return alive && ws != null && ws.State == WebSocketState.Open; } }

        public WsTransport(string server)
        {
            UriBuilder b = new UriBuilder(server);
            b.Scheme = b.Scheme == "http" ? "ws" : "wss";
            b.Port = new Uri(server).Port;
            b.Path = b.Path.TrimEnd('/') + "/agent/ws";
            uri = b.Uri;
        }

        public void Connect(Dictionary<string, object> hello)
        {
            ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            ws.Options.Proxy = Net.Proxy;
            CancellationTokenSource cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            ws.ConnectAsync(uri, cts.Token).Wait();
            alive = true;
            Thread t = new Thread(ReceiveLoop);
            t.IsBackground = true;
            t.Name = "ws-receive";
            t.Start();
            SendJson(hello);
            if (!welcome.WaitOne(TimeSpan.FromSeconds(15)) || !alive)
                throw new Exception("server did not accept the agent (wrong key, or WebSocket blocked by a proxy)");
        }

        void ReceiveLoop()
        {
            byte[] buf = new byte[64 * 1024];
            MemoryStream acc = new MemoryStream();
            try
            {
                while (ws.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult r = ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
                    if (r.MessageType == WebSocketMessageType.Close)
                    {
                        Log.Warn("Server closed the connection: " + r.CloseStatusDescription);
                        break;
                    }
                    acc.Write(buf, 0, r.Count);
                    if (!r.EndOfMessage) continue;
                    string text = Encoding.UTF8.GetString(acc.GetBuffer(), 0, (int)acc.Length);
                    acc.SetLength(0);
                    Dictionary<string, object> m = Json.Parse(text);
                    string t = Json.Str(m, "t");
                    if (t == "ack") ack.Set();
                    else if (t == "welcome") welcome.Set();
                    else if (Command != null) Command(m);
                }
            }
            catch (Exception e) { if (alive) Log.Warn("WebSocket receive ended: " + Root(e).Message); }
            alive = false;
            ack.Set();
            welcome.Set();
        }

        void Send(byte[] data, WebSocketMessageType type)
        {
            lock (sendLock)
            {
                if (!alive) throw new IOException("connection closed");
                CancellationTokenSource cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                ws.SendAsync(new ArraySegment<byte>(data), type, true, cts.Token).Wait();
            }
        }

        public void SendJson(Dictionary<string, object> msg)
        {
            Send(Encoding.UTF8.GetBytes(Json.Write(msg)), WebSocketMessageType.Text);
        }

        public void SendFrame(byte[] frame)
        {
            ack.Reset();
            Send(frame, WebSocketMessageType.Binary);
            if (!ack.WaitOne(TimeSpan.FromSeconds(30)) || !alive) throw new IOException("no acknowledgement from server");
        }

        public void Dispose()
        {
            alive = false;
            try { if (ws != null) ws.Abort(); } catch { }
            try { if (ws != null) ws.Dispose(); } catch { }
        }

        public static Exception Root(Exception e)
        {
            while (e.InnerException != null) e = e.InnerException;
            return e;
        }
    }

    // Pure HTTPS request/response. Works through proxies that only understand plain HTTP(S).
    class PollTransport : ITransport
    {
        readonly string server;
        string sid;
        volatile bool alive;
        Thread poller;
        public event Action<Dictionary<string, object>> Command;
        public string Name { get { return "https-poll"; } }
        public bool Alive { get { return alive; } }

        public PollTransport(string server) { this.server = server; }

        HttpWebRequest Req(string path, string method, int timeoutMs)
        {
            HttpWebRequest r = (HttpWebRequest)WebRequest.Create(server + path);
            r.Method = method;
            r.Proxy = Net.Proxy;
            r.Timeout = timeoutMs;
            r.ReadWriteTimeout = timeoutMs;
            r.KeepAlive = true;
            r.UserAgent = "NodeSafeRDP-Agent/" + Program.Version;
            r.Headers["Cache-Control"] = "no-cache";
            r.Headers["Pragma"] = "no-cache";
            if (sid != null) r.Headers["X-NSR-Session"] = sid;
            return r;
        }

        Dictionary<string, object> Call(string path, string method, byte[] body, string contentType, int timeoutMs)
        {
            HttpWebRequest r = Req(path, method, timeoutMs);
            if (body != null)
            {
                r.ContentType = contentType;
                r.ContentLength = body.Length;
                using (Stream s = r.GetRequestStream()) s.Write(body, 0, body.Length);
            }
            try
            {
                using (HttpWebResponse resp = (HttpWebResponse)r.GetResponse())
                using (StreamReader rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return Json.Parse(rd.ReadToEnd());
            }
            catch (WebException we)
            {
                HttpWebResponse er = we.Response as HttpWebResponse;
                if (er != null)
                {
                    int code = (int)er.StatusCode;
                    er.Close();
                    if (code == 410) { alive = false; throw new IOException("server ended the session"); }
                    if (code == 403) { alive = false; throw new IOException("server rejected the agent key (403)"); }
                    throw new IOException("HTTP " + code + " from server");
                }
                throw;
            }
        }

        void Dispatch(Dictionary<string, object> resp)
        {
            object cmds;
            if (resp == null || !resp.TryGetValue("cmds", out cmds) || !(cmds is System.Collections.IEnumerable)) return;
            foreach (object o in (System.Collections.IEnumerable)cmds)
            {
                Dictionary<string, object> m = o as Dictionary<string, object>;
                if (m != null && Command != null) Command(m);
            }
        }

        public void Connect(Dictionary<string, object> hello)
        {
            Dictionary<string, object> r = Call("/agent/connect", "POST", Encoding.UTF8.GetBytes(Json.Write(hello)), "application/json", 30000);
            sid = Json.Str(r, "sid");
            if (string.IsNullOrEmpty(sid)) throw new Exception("server did not return a session");
            alive = true;
            poller = new Thread(PollLoop);
            poller.IsBackground = true;
            poller.Name = "https-poll";
            poller.Start();
        }

        void PollLoop()
        {
            int errors = 0;
            while (alive)
            {
                try
                {
                    Dispatch(Call("/agent/poll", "GET", null, null, 45000));
                    errors = 0;
                }
                catch (Exception e)
                {
                    if (!alive) break;
                    errors++;
                    Log.Warn("Poll failed (" + errors + "): " + WsTransport.Root(e).Message);
                    if (errors >= 4) { alive = false; break; }
                    Thread.Sleep(1000 * errors);
                }
            }
        }

        public void SendFrame(byte[] frame)
        {
            Dispatch(Call("/agent/frame", "POST", frame, "application/octet-stream", 60000));
        }

        public void SendJson(Dictionary<string, object> msg)
        {
            Dispatch(Call("/agent/msg", "POST", Encoding.UTF8.GetBytes(Json.Write(msg)), "application/json", 30000));
        }

        public void Dispose()
        {
            if (!alive) return;
            alive = false;
            try { Call("/agent/bye", "POST", new byte[0], "application/json", 5000); } catch { }
        }
    }

    // ------------------------------------------------------------------------------------
    // Agent: connection management, command handling, capture loop
    // ------------------------------------------------------------------------------------
    class Agent
    {
        readonly Config cfg;
        readonly Capturer capturer = new Capturer();
        readonly object settingsLock = new object();
        volatile bool streaming;
        volatile bool keyframe;
        int quality = 60, monitor = 0, fps = 12;
        double scale = 1.0;
        DateTime preferPollUntil = DateTime.MinValue;
        string lastViewers = "";

        public Agent(Config cfg) { this.cfg = cfg; }

        Dictionary<string, object> Hello()
        {
            Dictionary<string, object> h = new Dictionary<string, object>();
            h["t"] = "hello";
            h["id"] = cfg.Id;
            h["key"] = cfg.Key;
            h["name"] = cfg.Name;
            h["version"] = Program.Version;
            h["os"] = Native.OsName();
            h["user"] = Environment.UserDomainName + "\\" + Environment.UserName;
            h["monitors"] = Capturer.Monitors();
            return h;
        }

        ITransport Create(bool poll)
        {
            return poll ? (ITransport)new PollTransport(cfg.Server) : new WsTransport(cfg.Server);
        }

        public void RunForever()
        {
            int backoff = 1;
            while (true)
            {
                bool usePoll = cfg.Transport == "poll" || (cfg.Transport == "auto" && DateTime.UtcNow < preferPollUntil);
                ITransport t = null;
                try
                {
                    t = TryConnect(usePoll);
                    backoff = 1;
                    Serve(t);
                }
                catch (Exception e)
                {
                    Log.Warn("Connection problem: " + WsTransport.Root(e).Message);
                }
                finally
                {
                    streaming = false;
                    Native.AllowSleep();
                    if (t != null) t.Dispose();
                }
                int wait = Math.Min(30, backoff);
                Log.Info("Reconnecting in " + wait + "s...");
                Thread.Sleep(wait * 1000);
                backoff = Math.Min(30, backoff * 2);
            }
        }

        ITransport TryConnect(bool poll)
        {
            ITransport t = Create(poll);
            t.Command += OnCommand;
            try
            {
                Log.Info("Connecting via " + t.Name + "...");
                t.Connect(Hello());
                Log.Info("Connected via " + t.Name + ".");
                return t;
            }
            catch (Exception e)
            {
                t.Dispose();
                if (poll || cfg.Transport != "auto") throw;
                Log.Warn("WebSocket failed (" + WsTransport.Root(e).Message + "); falling back to HTTPS polling.");
                preferPollUntil = DateTime.UtcNow.AddMinutes(10); // retry WebSocket later
                ITransport p = Create(true);
                p.Command += OnCommand;
                try
                {
                    p.Connect(Hello());
                    Log.Info("Connected via " + p.Name + ".");
                    return p;
                }
                catch { p.Dispose(); throw; }
            }
        }

        void Serve(ITransport t)
        {
            Stopwatch hb = Stopwatch.StartNew();
            while (t.Alive)
            {
                if (hb.Elapsed.TotalSeconds > 15)
                {
                    hb.Restart();
                    Dictionary<string, object> m = new Dictionary<string, object>();
                    m["t"] = "hb";
                    t.SendJson(m);
                }
                if (!streaming) { Thread.Sleep(100); continue; }

                int q, mon, f; double sc; bool full;
                lock (settingsLock) { q = quality; mon = monitor; f = fps; sc = scale; full = keyframe; keyframe = false; }
                Stopwatch sw = Stopwatch.StartNew();
                byte[] frame = null;
                try { frame = capturer.Capture(mon, sc, q, full); }
                catch (Exception e)
                {
                    // Happens on the lock screen / UAC secure desktop, which a non-admin process cannot see.
                    Log.Warn("Screen capture unavailable: " + e.Message);
                    lock (settingsLock) keyframe = true;
                    Thread.Sleep(1000);
                    continue;
                }
                if (frame != null) t.SendFrame(frame);
                int budget = 1000 / Math.Max(1, f) - (int)sw.ElapsedMilliseconds;
                Thread.Sleep(Math.Max(frame == null ? 30 : 5, budget));
            }
        }

        void OnCommand(Dictionary<string, object> m)
        {
            try
            {
                string t = Json.Str(m, "t");
                switch (t)
                {
                    case "stream":
                        bool on = Json.Bool(m, "on");
                        lock (settingsLock)
                        {
                            quality = (int)Json.Num(m, "q", quality);
                            scale = Json.Num(m, "scale", scale);
                            monitor = (int)Json.Num(m, "monitor", monitor);
                            fps = (int)Json.Num(m, "fps", fps);
                            keyframe = true;
                        }
                        if (on != streaming) Log.Notice(on ? "Screen sharing STARTED" : "Screen sharing stopped (no viewers)");
                        streaming = on;
                        if (on) Native.KeepAwake(); else Native.AllowSleep();
                        break;
                    case "key":
                        lock (settingsLock) keyframe = true;
                        break;
                    case "viewers":
                        List<string> names = new List<string>();
                        System.Collections.IEnumerable users = m.ContainsKey("users") ? m["users"] as System.Collections.IEnumerable : null;
                        if (users != null) foreach (object u in users) names.Add(Convert.ToString(u));
                        string list = string.Join(", ", names.ToArray());
                        if (list != lastViewers)
                        {
                            lastViewers = list;
                            Log.Notice(list.Length == 0 ? "No one is viewing this computer." : "Now viewing this computer: " + list);
                        }
                        break;
                    case "mm":
                        Input.MoveTo(capturer.MonitorBounds(monitor), Json.Num(m, "x", 0), Json.Num(m, "y", 0));
                        break;
                    case "md":
                    case "mu":
                        Input.Button((int)Json.Num(m, "b", 0), t == "md");
                        break;
                    case "wh":
                        Input.Wheel((int)Json.Num(m, "dy", 0), (int)Json.Num(m, "dx", 0));
                        break;
                    case "kd":
                    case "ku":
                        Input.Key((int)Json.Num(m, "vk", 0), Json.Bool(m, "ext"), t == "kd");
                        break;
                    case "txt":
                        Input.Text(Json.Str(m, "text") ?? "");
                        break;
                }
            }
            catch (Exception e) { Log.Warn("Command failed: " + e.Message); }
        }
    }

    // ------------------------------------------------------------------------------------
    // Screen capture with tile-based change detection. Only changed regions are sent (JPEG).
    // ------------------------------------------------------------------------------------
    class Capturer
    {
        const int Tile = 128;
        Bitmap raw, scaled;
        int[] prev, cur;
        int pw, ph;
        ImageCodecInfo jpeg;

        public Capturer()
        {
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
                if (c.MimeType == "image/jpeg") jpeg = c;
        }

        public static List<Dictionary<string, object>> Monitors()
        {
            List<Dictionary<string, object>> l = new List<Dictionary<string, object>>();
            Screen[] s = Screen.AllScreens;
            for (int i = 0; i < s.Length; i++)
            {
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["w"] = s[i].Bounds.Width; d["h"] = s[i].Bounds.Height;
                d["primary"] = s[i].Primary; d["name"] = s[i].DeviceName;
                l.Add(d);
            }
            return l;
        }

        public Rectangle MonitorBounds(int i)
        {
            Screen[] s = Screen.AllScreens;
            if (i < 0 || i >= s.Length) i = 0;
            return s[i].Bounds;
        }

        // Returns a frame (wire format) or null if nothing changed.
        public byte[] Capture(int monitor, double scale, int quality, bool full)
        {
            Rectangle b = MonitorBounds(monitor);
            if (raw == null || raw.Width != b.Width || raw.Height != b.Height)
            {
                if (raw != null) raw.Dispose();
                raw = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppRgb);
            }
            using (Graphics g = Graphics.FromImage(raw))
            {
                g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
                Native.DrawCursor(g, b);
            }

            Bitmap frame = raw;
            if (scale < 0.99)
            {
                int sw = Math.Max(16, (int)(b.Width * scale)), sh = Math.Max(16, (int)(b.Height * scale));
                if (scaled == null || scaled.Width != sw || scaled.Height != sh)
                {
                    if (scaled != null) scaled.Dispose();
                    scaled = new Bitmap(sw, sh, PixelFormat.Format32bppRgb);
                }
                using (Graphics g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = InterpolationMode.Bilinear;
                    g.PixelOffsetMode = PixelOffsetMode.Half;
                    g.DrawImage(raw, new Rectangle(0, 0, sw, sh));
                }
                frame = scaled;
            }

            int w = frame.Width, h = frame.Height;
            bool reset = full || prev == null || pw != w || ph != h;
            if (cur == null || cur.Length != w * h) cur = new int[w * h];
            BitmapData bd = frame.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                if (bd.Stride == w * 4) Marshal.Copy(bd.Scan0, cur, 0, w * h);
                else for (int y = 0; y < h; y++) Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), cur, y * w, w);
            }
            finally { frame.UnlockBits(bd); }

            int cols = (w + Tile - 1) / Tile, rows = (h + Tile - 1) / Tile;
            List<Rectangle> rects = new List<Rectangle>();
            for (int ty = 0; ty < rows; ty++)
            {
                int runStart = -1;
                for (int tx = 0; tx <= cols; tx++)
                {
                    bool changed = tx < cols && (reset || TileChanged(tx, ty, w, h));
                    if (changed && runStart < 0) runStart = tx;
                    if (!changed && runStart >= 0)
                    {
                        // merge horizontally adjacent changed tiles into one rectangle
                        int x0 = runStart * Tile, y0 = ty * Tile;
                        int x1 = Math.Min(w, tx * Tile), y1 = Math.Min(h, y0 + Tile);
                        rects.Add(new Rectangle(x0, y0, x1 - x0, y1 - y0));
                        runStart = -1;
                    }
                }
            }

            int[] tmp = prev; prev = cur; cur = tmp; pw = w; ph = h;
            if (rects.Count == 0) return null;

            EncoderParameters ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(10, Math.Min(95, quality)));
            List<byte[]> blobs = new List<byte[]>();
            StringBuilder hdr = new StringBuilder();
            hdr.Append("{\"w\":").Append(w).Append(",\"h\":").Append(h).Append(",\"reset\":").Append(reset ? "true" : "false").Append(",\"tiles\":[");
            for (int i = 0; i < rects.Count; i++)
            {
                Rectangle r = rects[i];
                byte[] data;
                using (Bitmap t = frame.Clone(r, PixelFormat.Format24bppRgb))
                using (MemoryStream ms = new MemoryStream())
                {
                    t.Save(ms, jpeg, ep);
                    data = ms.ToArray();
                }
                blobs.Add(data);
                if (i > 0) hdr.Append(',');
                hdr.Append('[').Append(r.X).Append(',').Append(r.Y).Append(',').Append(r.Width).Append(',').Append(r.Height).Append(',').Append(data.Length).Append(']');
            }
            hdr.Append("]}");
            byte[] hb = Encoding.UTF8.GetBytes(hdr.ToString());
            int total = 4 + hb.Length;
            foreach (byte[] x in blobs) total += x.Length;
            byte[] outb = new byte[total];
            outb[0] = (byte)(hb.Length >> 24); outb[1] = (byte)(hb.Length >> 16); outb[2] = (byte)(hb.Length >> 8); outb[3] = (byte)hb.Length;
            Buffer.BlockCopy(hb, 0, outb, 4, hb.Length);
            int off = 4 + hb.Length;
            foreach (byte[] x in blobs) { Buffer.BlockCopy(x, 0, outb, off, x.Length); off += x.Length; }
            return outb;
        }

        bool TileChanged(int tx, int ty, int w, int h)
        {
            int x0 = tx * Tile, y0 = ty * Tile;
            int x1 = Math.Min(w, x0 + Tile), y1 = Math.Min(h, y0 + Tile);
            for (int y = y0; y < y1; y++)
            {
                int i = y * w + x0, end = y * w + x1;
                for (; i < end; i++) if (cur[i] != prev[i]) return true;
            }
            return false;
        }
    }

    // ------------------------------------------------------------------------------------
    // Input injection (SendInput). Note: Windows blocks input from a non-admin process into
    // windows of elevated (admin) programs, the UAC prompt and the lock screen (UIPI).
    // ------------------------------------------------------------------------------------
    static class Input
    {
        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040,
            WHEEL = 0x0800, HWHEEL = 0x1000, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
        const uint KEYUP = 0x0002, EXTENDED = 0x0001, UNICODE = 0x0004;

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public UNION u; }

        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

        static void Send(params INPUT[] ins) { SendInput((uint)ins.Length, ins, Marshal.SizeOf(typeof(INPUT))); }

        static INPUT Mouse(uint flags, int dx, int dy, uint data)
        {
            INPUT i = new INPUT(); i.type = INPUT_MOUSE;
            i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data;
            return i;
        }

        public static void MoveTo(Rectangle mon, double nx, double ny)
        {
            int px = mon.X + (int)Math.Round(Math.Max(0, Math.Min(1, nx)) * (mon.Width - 1));
            int py = mon.Y + (int)Math.Round(Math.Max(0, Math.Min(1, ny)) * (mon.Height - 1));
            int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
            int ax = (int)Math.Round((px - vx) * 65535.0 / Math.Max(1, vw - 1));
            int ay = (int)Math.Round((py - vy) * 65535.0 / Math.Max(1, vh - 1));
            Send(Mouse(MOVE | ABSOLUTE | VIRTUALDESK, ax, ay, 0));
        }

        public static void Button(int b, bool down)
        {
            uint f = b == 1 ? (down ? RDOWN : RUP) : b == 2 ? (down ? MDOWN : MUP) : (down ? LDOWN : LUP);
            Send(Mouse(f, 0, 0, 0));
        }

        public static void Wheel(int dy, int dx)
        {
            if (dy != 0) Send(Mouse(WHEEL, 0, 0, unchecked((uint)dy)));
            if (dx != 0) Send(Mouse(HWHEEL, 0, 0, unchecked((uint)dx)));
        }

        public static void Key(int vk, bool ext, bool down)
        {
            if (vk <= 0 || vk > 254) return;
            INPUT i = new INPUT(); i.type = INPUT_KEYBOARD;
            i.u.ki.wVk = (ushort)vk;
            i.u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
            i.u.ki.dwFlags = (ext ? EXTENDED : 0) | (down ? 0 : KEYUP);
            Send(i);
        }

        public static void Text(string s)
        {
            foreach (char c in s.Replace("\r\n", "\n"))
            {
                if (c == '\n') { Key(0x0D, false, true); Key(0x0D, false, false); continue; }
                INPUT d = new INPUT(); d.type = INPUT_KEYBOARD; d.u.ki.wScan = c; d.u.ki.dwFlags = UNICODE;
                INPUT u = d; u.u.ki.dwFlags = UNICODE | KEYUP;
                Send(d, u);
            }
        }
    }

    // ------------------------------------------------------------------------------------
    static class Native
    {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint f);

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT pt; }
        [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
        [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr h, out ICONINFO ii);
        [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

        public static void EnableDpiAwareness()
        {
            // Per-monitor v2 so captured pixels and mouse coordinates are physical pixels.
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        public static void KeepAwake() { SetThreadExecutionState(0x80000000u | 0x00000001u | 0x00000002u); }
        public static void AllowSleep() { SetThreadExecutionState(0x80000000u); }

        public static void DrawCursor(Graphics g, Rectangle mon)
        {
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
            ICONINFO ii;
            int hx = 0, hy = 0;
            if (GetIconInfo(ci.hCursor, out ii))
            {
                hx = ii.xHotspot; hy = ii.yHotspot;
                if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
            }
            int x = ci.pt.x - mon.X - hx, y = ci.pt.y - mon.Y - hy;
            if (x < -64 || y < -64 || x > mon.Width || y > mon.Height) return;
            IntPtr hdc = g.GetHdc();
            try { DrawIconEx(hdc, x, y, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
            finally { g.ReleaseHdc(hdc); }
        }

        public static string OsName()
        {
            try
            {
                using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    string name = Convert.ToString(k.GetValue("ProductName"));
                    string build = Convert.ToString(k.GetValue("CurrentBuildNumber"));
                    string disp = Convert.ToString(k.GetValue("DisplayVersion"));
                    int b;
                    // Windows 11 still reports "Windows 10" in ProductName
                    if (int.TryParse(build, out b) && b >= 22000) name = name.Replace("Windows 10", "Windows 11");
                    return name + " " + disp + " (build " + build + ")";
                }
            }
            catch { return Environment.OSVersion.ToString(); }
        }
    }
}
