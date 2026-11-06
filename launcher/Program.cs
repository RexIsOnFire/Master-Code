// Master Code launcher.
//
// Double-clicking this should be the entire setup: it locates the installation,
// finds Node, starts the IDE server on a free port, waits for it to answer, and
// opens the default browser. Closing the window stops the server.
//
// Everything it does is something you could do by hand in a terminal. The point
// is that you should not have to, and that when a step fails it says which step
// and what to do about it — a launcher that dies silently is worse than no
// launcher at all.

using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace MasterCode;

internal static class Program
{
    /// <summary>Node's TypeScript type stripping, which the whole project relies on.</summary>
    private const int MinNodeMajor = 22;
    private const int MinNodeMinor = 6;

    private const int PreferredPort = 4488;

    private static Process? _server;
    private static IntPtr _job = IntPtr.Zero;

    private static int Main(string[] args)
    {
        Console.Title = "Master Code";
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Banner();

        try
        {
            var installRoot = FindInstallRoot();
            if (installRoot is null)
            {
                return Fail(
                    "Could not find the Master Code files.",
                    "Keep MasterCode.exe inside the Master Code folder, next to the 'packages' directory.");
            }

            var serverScript = Path.Combine(installRoot, "packages", "server", "src", "main.ts");
            Step($"Installation  {installRoot}");

            var node = FindNode();
            if (node is null)
            {
                return Fail(
                    "Node.js is not installed, or is not on the PATH.",
                    $"Master Code needs Node {MinNodeMajor}.{MinNodeMinor} or newer. Get it from https://nodejs.org and run this again.");
            }

            var version = NodeVersion(node);
            if (version is null)
            {
                return Fail($"Found Node at {node}, but could not read its version.", "Try running 'node --version' in a terminal.");
            }
            if (!VersionIsSupported(version.Value))
            {
                return Fail(
                    $"Node {version.Value.Major}.{version.Value.Minor} is too old.",
                    $"Master Code needs {MinNodeMajor}.{MinNodeMinor} or newer, which is the first version that runs TypeScript directly.");
            }
            Step($"Node          v{version.Value.Major}.{version.Value.Minor} ({node})");

            var port = FindFreePort(PreferredPort);
            var url = $"http://127.0.0.1:{port}/";

            // The server opens whatever project is in its working directory. A
            // project folder passed on the command line (or dropped on the exe)
            // opens straight into it; otherwise it starts somewhere neutral so
            // the welcome screen appears rather than an arbitrary project.
            var workingDir = ChooseWorkingDirectory(args, installRoot);
            Step($"Project       {(File.Exists(Path.Combine(workingDir, "project.json")) ? workingDir : "welcome screen")}");

            if (!StartServer(node, serverScript, workingDir, port))
            {
                return Fail("The IDE server did not start.", "The messages above should say why.");
            }

            Step($"Address       {url}");
            Console.WriteLine();
            OpenBrowser(url);
            Console.WriteLine("  Master Code is running. Leave this window open.");
            Console.WriteLine("  Press Ctrl+C, or close this window, to stop it.");
            Console.WriteLine();

            WaitForShutdown();
            return 0;
        }
        catch (Exception ex)
        {
            return Fail("Something went wrong starting Master Code.", ex.Message);
        }
        finally
        {
            StopServer();
        }
    }

    // -----------------------------------------------------------------------
    // Locating things
    // -----------------------------------------------------------------------

    /// <summary>
    /// Walks up from the executable looking for the packages directory, so the
    /// exe works whether it sits at the repository root or inside launcher/.
    /// </summary>
    private static string? FindInstallRoot()
    {
        var candidates = new List<string>();
        var exeDir = AppContext.BaseDirectory;
        var dir = new DirectoryInfo(exeDir);
        while (dir is not null)
        {
            candidates.Add(dir.FullName);
            dir = dir.Parent;
        }
        candidates.Add(Directory.GetCurrentDirectory());

        foreach (var candidate in candidates)
        {
            if (File.Exists(Path.Combine(candidate, "packages", "server", "src", "main.ts")))
            {
                return candidate;
            }
        }
        return null;
    }

    /// <summary>PATH first, then the usual Windows install locations.</summary>
    private static string? FindNode()
    {
        var fromEnv = Environment.GetEnvironmentVariable("MASTERCODE_NODE");
        if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(fromEnv)) return fromEnv;

        var isWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        var exeName = isWindows ? "node.exe" : "node";

        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var entry in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var full = Path.Combine(entry.Trim('"'), exeName);
                if (File.Exists(full)) return full;
            }
            catch (ArgumentException)
            {
                // A malformed PATH entry is not worth failing over.
            }
        }

        if (!isWindows) return null;
        var guesses = new[]
        {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            @"C:\nvm4w\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
        };
        return guesses.FirstOrDefault(File.Exists);
    }

    private static (int Major, int Minor)? NodeVersion(string node)
    {
        try
        {
            using var probe = Process.Start(new ProcessStartInfo(node, "--version")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (probe is null) return null;
            var text = probe.StandardOutput.ReadToEnd().Trim().TrimStart('v');
            probe.WaitForExit(5000);

            var parts = text.Split('.');
            if (parts.Length < 2) return null;
            if (!int.TryParse(parts[0], out var major) || !int.TryParse(parts[1], out var minor)) return null;
            return (major, minor);
        }
        catch
        {
            return null;
        }
    }

    private static bool VersionIsSupported((int Major, int Minor) v) =>
        v.Major > MinNodeMajor || (v.Major == MinNodeMajor && v.Minor >= MinNodeMinor);

    private static string ChooseWorkingDirectory(string[] args, string installRoot)
    {
        foreach (var arg in args)
        {
            if (Directory.Exists(arg) && File.Exists(Path.Combine(arg, "project.json"))) return Path.GetFullPath(arg);
            // Dropping the project file itself on the exe should work too.
            if (File.Exists(arg) && Path.GetFileName(arg) == "project.json")
            {
                return Path.GetDirectoryName(Path.GetFullPath(arg))!;
            }
        }

        var cwd = Directory.GetCurrentDirectory();
        if (File.Exists(Path.Combine(cwd, "project.json"))) return cwd;

        // Neutral, and guaranteed to exist: the welcome screen takes it from here.
        return installRoot;
    }

    private static int FindFreePort(int preferred)
    {
        for (var port = preferred; port < preferred + 40; port++)
        {
            if (IsPortFree(port)) return port;
        }
        // Let the OS pick if that whole range is somehow taken.
        using var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var chosen = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return chosen;
    }

    private static bool IsPortFree(int port)
    {
        try
        {
            using var probe = new TcpListener(IPAddress.Loopback, port);
            probe.Start();
            probe.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Making sure the server dies with us
    // -----------------------------------------------------------------------

    // Ctrl+C and a clean exit are handled in managed code, but neither covers a
    // hard kill or, on some Windows versions, closing the console window. A job
    // object with KILL_ON_JOB_CLOSE does: the handle dies with the process, and
    // the kernel takes the children with it. Without this, a killed launcher
    // leaves a server holding port 4488 and the next launch silently uses 4489.

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInfo
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobObjectExtendedLimitInfo info, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    /// <summary>Best effort: if any of this fails, the managed cleanup still runs.</summary>
    private static void TieToLifetime(Process child)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;
        try
        {
            _job = CreateJobObjectW(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) return;

            var info = new JobObjectExtendedLimitInfo();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var size = Marshal.SizeOf<JobObjectExtendedLimitInfo>();
            if (!SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ref info, size)) return;

            AssignProcessToJobObject(_job, child.Handle);
        }
        catch (DllNotFoundException)
        {
            // Not Windows after all; the managed path covers it.
        }
        catch (EntryPointNotFoundException)
        {
        }
    }

    // -----------------------------------------------------------------------
    // The server
    // -----------------------------------------------------------------------

    private static bool StartServer(string node, string script, string workingDir, int port)
    {
        var info = new ProcessStartInfo(node)
        {
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        info.ArgumentList.Add(script);
        info.Environment["MASTERCODE_PORT"] = port.ToString();
        info.Environment["MASTERCODE_HOST"] = "127.0.0.1";

        _server = Process.Start(info);
        if (_server is null) return false;
        TieToLifetime(_server);

        // Forward the server's own output. When something goes wrong inside
        // Node, its message is the useful one; swallowing it to keep the window
        // tidy would be a poor trade.
        _server.OutputDataReceived += (_, e) => { if (e.Data is not null) Console.WriteLine($"  {e.Data}"); };
        _server.ErrorDataReceived += (_, e) => { if (e.Data is not null) Console.Error.WriteLine($"  {e.Data}"); };
        _server.BeginOutputReadLine();
        _server.BeginErrorReadLine();

        // Poll rather than sleep a fixed amount: a cold start on a slow disk can
        // take a few seconds, and a warm one is instant.
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (_server.HasExited)
            {
                Console.Error.WriteLine($"  The server exited with code {_server.ExitCode}.");
                return false;
            }
            if (Accepting(port)) return true;
            Thread.Sleep(150);
        }
        Console.Error.WriteLine("  Timed out waiting for the server to answer.");
        return false;
    }

    private static bool Accepting(int port)
    {
        try
        {
            using var client = new TcpClient();
            var attempt = client.BeginConnect(IPAddress.Loopback, port, null, null);
            if (!attempt.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(400))) return false;
            client.EndConnect(attempt);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void StopServer()
    {
        try
        {
            if (_server is { HasExited: false })
            {
                // Kill the tree: the server spawns compilers and the programs
                // being run, and leaving those behind would hold ports and file
                // locks after the window closes.
                _server.Kill(entireProcessTree: true);
                _server.WaitForExit(5000);
            }
        }
        catch
        {
            // Shutting down; nothing useful left to report.
        }
    }

    private static void WaitForShutdown()
    {
        using var stop = new ManualResetEventSlim(false);
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stop.Set();
        };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => StopServer();

        // Also stop if the server dies on its own, so the window does not sit
        // there claiming to be running.
        if (_server is not null)
        {
            _server.EnableRaisingEvents = true;
            _server.Exited += (_, _) => stop.Set();
        }
        stop.Wait();
        Console.WriteLine("  Stopping…");
    }

    // -----------------------------------------------------------------------

    private static void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
        }
        catch
        {
            Console.WriteLine($"  Could not open a browser. Go to {url} yourself.");
        }
    }

    private static void Banner()
    {
        Console.WriteLine();
        Console.WriteLine("  Master Code");
        Console.WriteLine("  -----------");
    }

    private static void Step(string text) => Console.WriteLine($"  {text}");

    private static int Fail(string what, string whatToDo)
    {
        Console.WriteLine();
        Console.Error.WriteLine($"  {what}");
        Console.Error.WriteLine($"  {whatToDo}");
        Console.WriteLine();
        Console.WriteLine("  Press Enter to close.");
        try
        {
            Console.ReadLine();
        }
        catch (InvalidOperationException)
        {
            // No console attached; nothing to wait for.
        }
        return 1;
    }
}
