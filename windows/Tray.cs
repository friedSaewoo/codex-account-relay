using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class RelayTray : ApplicationContext
{
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly string state;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly NotifyIcon icon = new NotifyIcon();
    readonly Icon appIcon = LoadAppIcon();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly Queue<DateTime> crashes = new Queue<DateTime>();
    readonly ToolStripMenuItem heading = new ToolStripMenuItem("시작 중…");
    readonly ToolStripMenuItem businessUsageItem = new ToolStripMenuItem("Business · 조회 중…");
    readonly ToolStripMenuItem proUsageItem = new ToolStripMenuItem("Pro · 조회 중…");
    readonly ToolStripMenuItem usageCheckedItem = new ToolStripMenuItem("사용량 조회 중…");
    readonly ToolStripMenuItem autoItem = new ToolStripMenuItem("Business 우선 · 자동 전환");
    readonly ToolStripMenuItem proItem = new ToolStripMenuItem("Pro만 사용");
    readonly ToolStripMenuItem offItem = new ToolStripMenuItem("자동 관리 끄기 · 기본 연결 복구");
    readonly ToolStripMenuItem startupItem = new ToolStripMenuItem("Windows 로그인 시 자동 시작");
    Process manager, startupChange;
    string node, lastNotice = "";
    bool exiting, recoveryStopped;
    DateTime startedAt, lastHealthyHeartbeatAt;
    Form window;
    Label statusLabel;
    Label metricsLabel;
    readonly Label[] usageLabels = new Label[2];
    readonly ProgressBar[,] usageBars = new ProgressBar[2, 2];
    readonly Label[,] usageWindowLabels = new Label[2, 2];
    readonly Button[] resetButtons = new Button[2];
    Form resetDialog;
    Label resetCountLabel, resetCheckedLabel, resetMessageLabel;
    ListBox resetExpiryList;
    Button resetUseButton;
    int resetIndex;

    public RelayTray(bool showWindow, int existingManagerPid)
    {
        var runtime = Read(Path.Combine(root, "runtime.json"));
        state = Environment.GetEnvironmentVariable("CODEX_RELAY_HOME") ?? (Text(runtime, "stateHome").Length > 0 ? Text(runtime, "stateHome") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex-account-relay"));
        Directory.CreateDirectory(Path.Combine(state, "commands"));
        node = Text(runtime, "node");
        lastNotice = Text(Read(Path.Combine(state, "last-notice.json")), "key");
        var menu = new ContextMenuStrip();
        heading.Enabled = false;
        menu.Items.Add(heading);
        businessUsageItem.Click += delegate { ShowStatus(); };
        proUsageItem.Click += delegate { ShowStatus(); };
        usageCheckedItem.Enabled = false;
        menu.Items.AddRange(new ToolStripItem[] { businessUsageItem, proUsageItem, usageCheckedItem });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("상태 보기", null, delegate { ShowStatus(); });
        menu.Items.Add(new ToolStripSeparator());
        autoItem.Click += delegate { Mode("auto"); };
        proItem.Click += delegate { Mode("pro"); };
        offItem.Click += delegate { Mode("off"); };
        menu.Items.AddRange(new ToolStripItem[] { autoItem, proItem, offItem });
        menu.Items.Add(new ToolStripSeparator());
        startupItem.Click += delegate { SetStartup(!startupItem.Checked); };
        menu.Items.Add(startupItem);
        menu.Items.Add("Business 다시 로그인", null, delegate { Command("login", null); });
        menu.Items.Add("연결 다시 진단 (문제 시)", null, delegate { Recover(); Command("check", null); });
        menu.Items.Add("사용량 새로고침", null, delegate { Command("usage", null); ShowStatus(); });
        menu.Items.Add("사용 방법", null, delegate { Process.Start(new ProcessStartInfo(Path.Combine(root, "README.txt")) { UseShellExecute = true }); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("종료 (열린 Codex는 재시작 필요)", null, delegate { BeginExit(); });
        icon.Icon = appIcon;
        icon.Text = "Codex 계정 자동 관리";
        icon.ContextMenuStrip = menu;
        menu.Opening += delegate { UpdateTrayUsage(Read(Path.Combine(state, "manager-status.json"))); };
        icon.DoubleClick += delegate { ShowStatus(); };
        icon.BalloonTipClicked += delegate { ShowStatus(); };
        icon.Visible = true;
        if (existingManagerPid > 0) {
            var saved = Read(Path.Combine(state, "manager-status.json"));
            DateTimeOffset updated;
            if (Text(saved, "pid") != existingManagerPid.ToString() || Text(saved, "stopped") == "True" ||
                !DateTimeOffset.TryParse(Text(saved, "updated"), out updated) || (DateTimeOffset.UtcNow - updated).TotalSeconds > 10)
                throw new InvalidOperationException("Cannot attach to a live relay manager.");
            manager = Process.GetProcessById(existingManagerPid);
            if (manager.HasExited || !String.Equals(manager.MainModule.FileName, node, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Unexpected relay manager process.");
            startedAt = lastHealthyHeartbeatAt = DateTime.UtcNow;
        } else StartManager();
        timer.Interval = 2000;
        timer.Tick += delegate { Tick(); };
        timer.Start();
        if (showWindow) ShowStatus();
    }
    Dictionary<string, object> Read(string path)
    {
        try { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8)) ?? new Dictionary<string, object>(); }
        catch { return new Dictionary<string, object>(); }
    }
    static string Text(Dictionary<string, object> value, string key)
    {
        object result;
        return value.TryGetValue(key, out result) && result != null ? Convert.ToString(result) : "";
    }
    void Command(string action, string mode)
    {
        var value = new Dictionary<string, object>(); value["action"] = action;
        if (mode != null) value["mode"] = mode;
        string path = Path.Combine(state, "commands", Guid.NewGuid().ToString() + ".json");
        File.WriteAllText(path + ".tmp", json.Serialize(value), new UTF8Encoding(false));
        File.Move(path + ".tmp", path);
    }
    void Mode(string mode) { Recover(); Command("mode", mode); }
    void SetStartup(bool enable)
    {
        if (startupChange != null) return;
        try {
            startupChange = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "scripts", "set-startup.ps1") + "\" -Mode " + (enable ? "enable" : "disable")) {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            });
            startupItem.Enabled = false;
            startupChange.OutputDataReceived += delegate { }; startupChange.ErrorDataReceived += delegate { };
            startupChange.BeginOutputReadLine(); startupChange.BeginErrorReadLine();
        } catch { if (startupChange != null) startupChange.Dispose(); startupChange = null; startupItem.Enabled = true; Notice("startup-change", "자동 시작 설정 실패", "사용 방법에서 자동 시작 설정을 확인해주세요."); }
    }
    void Recover()
    {
        if (!recoveryStopped) return;
        crashes.Clear(); recoveryStopped = false; StartManager();
    }
    void StartManager()
    {
        try {
            if (!File.Exists(node)) throw new IOException("Node.js runtime missing");
            manager = new Process();
            manager.StartInfo = new ProcessStartInfo(node, "\"" + Path.Combine(root, "src", "manager.mjs") + "\"") {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            manager.StartInfo.EnvironmentVariables["CODEX_RELAY_HOME"] = state;
            // Output may contain an OAuth login URL. Drain it without persisting or displaying secrets.
            manager.OutputDataReceived += delegate { };
            manager.ErrorDataReceived += delegate { };
            manager.Start(); manager.BeginOutputReadLine(); manager.BeginErrorReadLine();
            startedAt = lastHealthyHeartbeatAt = DateTime.UtcNow;
        } catch { recoveryStopped = true; RestoreConfig(); Notice("runtime", "자동 관리 시작 실패", "기본 연결 복구를 시도했습니다. 상태 보기에서 다시 시도할 수 있습니다."); }
    }
    void RestoreConfig()
    {
        try {
            var p = Process.Start(new ProcessStartInfo(node, "\"" + Path.Combine(root, "src", "cli.mjs") + "\" disable") {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            });
            p.OutputDataReceived += delegate { }; p.ErrorDataReceived += delegate { };
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
        } catch { }
    }
    void Tick()
    {
        if (startupChange != null && startupChange.HasExited) {
            bool failed = startupChange.ExitCode != 0; startupChange.Dispose(); startupChange = null; startupItem.Enabled = true;
            if (failed) Notice("startup-change", "자동 시작 설정 실패", "시작 프로그램 등록을 변경하지 못했습니다. 사용 방법에서 설정을 확인해주세요.");
        }
        var s = Read(Path.Combine(state, "manager-status.json"));
        if (File.Exists(Path.Combine(state, "show-status.request"))) {
            try { File.Delete(Path.Combine(state, "show-status.request")); } catch { }
            ShowStatus();
        }
        if (manager != null && manager.HasExited && !exiting && !recoveryStopped) {
            int? exitCode = null;
            try { exitCode = manager.ExitCode; } catch { }
            Lifecycle("manager_exited", new Dictionary<string, object> { { "pid", manager.Id }, { "exitCode", exitCode } });
            if (Text(s, "pid") == manager.Id.ToString() && Text(s, "stopped") == "True") { ExitThread(); return; }
            DateTime now = DateTime.UtcNow;
            while (crashes.Count > 0 && (now - crashes.Peek()).TotalMinutes > 5) crashes.Dequeue();
            crashes.Enqueue(now);
            if (crashes.Count >= 3) {
                recoveryStopped = true; RestoreConfig();
                Notice("crashes", "자동 관리 복구 필요", "반복 종료를 감지해 기본 연결 복구를 시도했습니다. Codex를 다음에 다시 열어주세요.");
            } else { manager.Dispose(); StartManager(); }
        }
        if (manager != null && !manager.HasExited && !exiting) {
            DateTime now = DateTime.UtcNow;
            if (FreshHeartbeat(s, manager.Id, now)) lastHealthyHeartbeatAt = DateTimeOffset.Parse(Text(s, "updated")).UtcDateTime;
            else if (ShouldRestartManager(s, manager.Id, now, startedAt, lastHealthyHeartbeatAt)) {
                Lifecycle("watchdog_restart", new Dictionary<string, object> { { "pid", manager.Id }, { "secondsWithoutHealthyHeartbeat", (now - lastHealthyHeartbeatAt).TotalSeconds }, { "statusPidMatches", Text(s, "pid") == manager.Id.ToString() }, { "statusHasTimestamp", Text(s, "updated").Length > 0 } });
                try { manager.Kill(); } catch { }
            }
        }
        string label = recoveryStopped ? "자동 관리 복구 필요" : Text(s, "label");
        if (label.Length == 0) label = "시작 중…";
        heading.Text = label; icon.Text = label.Length > 63 ? label.Substring(0, 63) : label;
        string mode = Text(s, "mode"); autoItem.Checked = mode == "auto"; proItem.Checked = mode == "pro"; offItem.Checked = mode == "off";
        startupItem.Checked = Text(Read(Path.Combine(state, "installation.json")), "startupRegistered") == "True";
        string attention = Text(s, "attention");
        icon.Icon = attention.Length > 0 || recoveryStopped ? SystemIcons.Warning : appIcon;
        if (attention.Length > 0) Notice(attention, label, Text(s, "detail"));
        UpdateTrayUsage(s);
        UpdateStatus(s);
    }
    static bool FreshHeartbeat(Dictionary<string, object> status, int pid, DateTime now)
    {
        DateTimeOffset updated;
        return Text(status, "pid") == pid.ToString() && DateTimeOffset.TryParse(Text(status, "updated"), out updated) &&
            (new DateTimeOffset(now) - updated).TotalSeconds >= -5 && (new DateTimeOffset(now) - updated).TotalSeconds < 90;
    }
    static bool ShouldRestartManager(Dictionary<string, object> status, int pid, DateTime now, DateTime started, DateTime lastHealthy)
    {
        // Missing/unreadable or mismatched status is not proof that the live process is stuck.
        return !FreshHeartbeat(status, pid, now) && Text(status, "shuttingDown") != "True" &&
            (now - started).TotalSeconds > 100 && (now - lastHealthy).TotalSeconds > 90;
    }
    void Lifecycle(string name, Dictionary<string, object> detail)
    {
        try {
            string path = Path.Combine(state, "tray-audit.jsonl");
            if (File.Exists(path) && new FileInfo(path).Length > 2 * 1024 * 1024) {
                if (File.Exists(path + ".1")) File.Delete(path + ".1"); File.Move(path, path + ".1");
            }
            detail["at"] = DateTimeOffset.UtcNow.ToString("o"); detail["event"] = name;
            File.AppendAllText(path, json.Serialize(detail) + "\n", new UTF8Encoding(false));
        } catch { }
    }
    void UpdateTrayUsage(Dictionary<string, object> status)
    {
        var usage = Object(status, "usage");
        var business = Object(usage, "business"); var pro = Object(usage, "pro");
        businessUsageItem.Text = UsageMenuText("Business", business);
        proUsageItem.Text = UsageMenuText("Pro", pro);
        usageCheckedItem.Text = "조회 · Business " + LocalTime(Text(business, "updatedAt")) + " / Pro " + LocalTime(Text(pro, "updatedAt"));
    }
    static string UsageMenuText(string account, Dictionary<string, object> value)
    {
        var parts = new List<string>(); object windows;
        if (value.TryGetValue("windows", out windows) && windows is System.Collections.IEnumerable) {
            foreach (object item in (System.Collections.IEnumerable)windows) {
                var row = item as Dictionary<string, object>;
                double remaining;
                if (row == null || !Double.TryParse(Text(row, "remainingPercent"), out remaining)) continue;
                double seconds = Number(row, "durationSeconds");
                string period = seconds == 604800 ? "주간" : seconds == 18000 ? "5시간" : seconds >= 86400 ? (seconds / 86400).ToString("0.#") + "일" : seconds > 0 ? (seconds / 3600).ToString("0.#") + "시간" : "한도";
                parts.Add(period + " " + Math.Max(0, Math.Min(100, remaining)).ToString("0.#") + "%");
            }
        }
        if (parts.Count == 0) return account + " · " + (Text(value, "error").Length > 0 ? "조회 실패" : Text(value, "updatedAt").Length > 0 ? "한도 정보 미제공" : "조회 중…");
        DateTimeOffset updated;
        bool stale = Text(value, "stale") == "True" || Text(value, "error").Length > 0 || !DateTimeOffset.TryParse(Text(value, "updatedAt"), out updated) || (DateTimeOffset.UtcNow - updated).TotalMinutes > 6;
        return account + " 남음 · " + String.Join(" / ", parts.ToArray()) + (stale ? " (이전 조회 값)" : "");
    }
    void Notice(string key, string title, string detail)
    {
        if (lastNotice == key) return;
        lastNotice = key;
        try { File.WriteAllText(Path.Combine(state, "last-notice.json"), json.Serialize(new Dictionary<string, object> { { "key", key } }), new UTF8Encoding(false)); } catch { }
        icon.ShowBalloonTip(7000, title, detail, ToolTipIcon.Warning);
    }
    static Icon LoadAppIcon()
    {
        using (var stream = typeof(RelayTray).Assembly.GetManifestResourceStream("RelayIcon")) {
            if (stream == null) return (Icon)SystemIcons.Application.Clone();
            using (var embedded = new Icon(stream, new Size(32, 32))) return (Icon)embedded.Clone();
        }
    }
    void UpdateStatus(Dictionary<string, object> s)
    {
        if (statusLabel == null || statusLabel.IsDisposed) return;
        string label = recoveryStopped ? "자동 관리 복구 필요" : Text(s, "label");
        statusLabel.Text = label.Length > 0 ? label : "시작 중…";
        string route = Text(s, "lastModelRoute");
        string routeLabel = route == "business" ? "Business" : route == "pro" ? "Pro" : "아직 없음";
        bool processing = Number(s, "modelInFlight") > 0;
        metricsLabel.Text = "실제 모델 요청: Business " + Text(s, "modelBusiness") + " / Pro " + Text(s, "modelPro") +
            "\r\n보조 요청: Pro " + Text(s, "auxiliaryPro") + " (모델 목록 · 검색 등)" +
            "\r\n최근 모델: " + (Text(s, "lastModel").Length > 0 ? Text(s, "lastModel") : "아직 없음") + " · " + routeLabel +
            "\r\n" + (processing ? "모델 요청 처리 중" : "모델 요청 대기") +
            "\r\n자동 전환: " + Text(s, "fallbacks") + "회 · 호환성: " + Text(s, "compatibility");
        var usage = Object(s, "usage");
        UpdateUsageCard(0, Object(usage, "business"));
        UpdateUsageCard(1, Object(usage, "pro"));
        var resets = Object(s, "resetCredits");
        UpdateResetCard(0, Object(resets, "business"));
        UpdateResetCard(1, Object(resets, "pro"));
    }
    static Dictionary<string, object> Object(Dictionary<string, object> value, string key)
    {
        object result;
        return value.TryGetValue(key, out result) && result is Dictionary<string, object> ? (Dictionary<string, object>)result : new Dictionary<string, object>();
    }
    static double Number(Dictionary<string, object> value, string key)
    {
        double number;
        return Double.TryParse(Text(value, key), out number) ? number : 0;
    }
    static string LocalTime(string value)
    {
        DateTimeOffset time;
        return DateTimeOffset.TryParse(value, out time) ? time.ToLocalTime().ToString("MM/dd HH:mm") : "미제공";
    }
    void UpdateUsageCard(int index, Dictionary<string, object> value)
    {
        if (usageLabels[index] == null) return;
        string updated = Text(value, "updatedAt");
        string error = Text(value, "error");
        DateTimeOffset stamp;
        bool old = DateTimeOffset.TryParse(updated, out stamp) && (DateTimeOffset.UtcNow - stamp).TotalMinutes > 6;
        string usageStatus = error.Length > 0 ? "조회 실패" : updated.Length == 0 ? "조회 중…" : "조회 " + LocalTime(updated);
        usageLabels[index].Text = usageStatus;
        usageLabels[index].Visible = usageStatus.Length > 0;
        var rows = new List<Dictionary<string, object>>();
        object windows;
        if (value.TryGetValue("windows", out windows) && windows is System.Collections.IEnumerable) {
            foreach (object row in (System.Collections.IEnumerable)windows) if (row is Dictionary<string, object>) rows.Add((Dictionary<string, object>)row);
        }
        for (int row = 0; row < 2; row++) {
            var bar = usageBars[index, row]; var label = usageWindowLabels[index, row];
            label.Top = (usageStatus.Length > 0 ? 52 : 24) + row * 68;
            bar.Top = label.Top + 43;
            if (row >= rows.Count) { bar.Visible = false; label.Text = row == 0 ? "한도 정보 미제공" : "추가 한도 정보 없음"; continue; }
            var limit = rows[row];
            double seconds = Number(limit, "durationSeconds");
            string period = seconds == 604800 ? "주간" : seconds == 18000 ? "5시간" : seconds >= 86400 ? (seconds / 86400).ToString("0.#") + "일" : seconds > 0 ? (seconds / 3600).ToString("0.#") + "시간" : "한도";
            double remaining = Number(limit, "remainingPercent");
            label.Text = period + " · " + remaining.ToString("0.#") + "%" +
                "\r\n초기화 " + LocalTime(Text(limit, "resetsAt")) + (error.Length > 0 || old ? " (이전 조회 값)" : "");
            bar.Value = Math.Max(0, Math.Min(100, (int)Math.Round(remaining))); bar.Visible = true;
        }
    }
    string RemainingTime(string value)
    {
        DateTimeOffset time;
        if (!DateTimeOffset.TryParse(value, out time)) return "만료일 미제공";
        var span = time - DateTimeOffset.UtcNow;
        if (span.TotalSeconds <= 0) return "만료됨";
        return (span.Days > 0 ? span.Days + "일 " : "") + span.Hours + "시간 남음";
    }
    void UpdateResetCard(int index, Dictionary<string, object> value)
    {
        string count = Text(value, "availableCount");
        resetButtons[index].Text = "사용한도 초기화 (" + (count.Length > 0 ? count : "…") + ")";
        if (resetDialog != null && !resetDialog.IsDisposed && resetIndex == index) UpdateResetDialog(value);
    }
    List<string> ResetExpiryText(Dictionary<string, object> value)
    {
        var expiry = new List<string>();
        object rows;
        if (value.TryGetValue("expiries", out rows) && rows is System.Collections.IEnumerable) {
            foreach (object item in (System.Collections.IEnumerable)rows) {
                var row = item as Dictionary<string, object>;
                if (row != null) expiry.Add(LocalTime(Text(row, "expiresAt")) + " · " + RemainingTime(Text(row, "expiresAt")) + " (" + Text(row, "count") + "회)");
            }
        }
        return expiry;
    }
    void UpdateResetDialog(Dictionary<string, object> value)
    {
        string count = Text(value, "availableCount");
        resetCountLabel.Text = "초기화권 " + (count.Length > 0 ? count + "회" : "조회 중…");
        resetCheckedLabel.Text = Text(value, "updatedAt").Length > 0 ? "조회 " + LocalTime(Text(value, "updatedAt")) : "조회 중…";
        var expiry = ResetExpiryText(value);
        string message = Text(value, "message"), error = Text(value, "error");
        string contents = String.Join("\n", expiry.ToArray());
        if (resetExpiryList.Tag == null || Convert.ToString(resetExpiryList.Tag) != contents) {
            resetExpiryList.BeginUpdate(); resetExpiryList.Items.Clear();
            if (expiry.Count == 0) resetExpiryList.Items.Add(count == "0" ? "남은 초기화권 없음" : "만료일 정보 미제공");
            else foreach (string row in expiry) resetExpiryList.Items.Add(row);
            resetExpiryList.Tag = contents; resetExpiryList.EndUpdate();
        }
        resetMessageLabel.Text = error.Length > 0 ? error : message.Length > 0 ? message : "만료가 가장 빠른 초기화권부터 1회 사용합니다.";
        bool stale = Text(value, "stale") == "True";
        DateTimeOffset checkedAt;
        if (!DateTimeOffset.TryParse(Text(value, "updatedAt"), out checkedAt) || (DateTimeOffset.UtcNow - checkedAt).TotalMinutes > 6) stale = true;
        bool pending = Text(value, "pending") == "True", busy = Text(value, "busy") == "True";
        resetUseButton.Text = busy ? "처리 중…" : pending ? "결과 확인" : "초기화 1회 사용";
        resetUseButton.Enabled = !busy && (!stale || pending) && Text(value, "canUse") == "True";
    }
    void ShowResetDialog(int index)
    {
        if (resetDialog != null && !resetDialog.IsDisposed) {
            if (resetDialog.Visible) { resetDialog.Activate(); return; }
            resetDialog.Dispose(); resetDialog = null;
        }
        resetIndex = index;
        string name = index == 0 ? "Business" : "Pro";
        resetDialog = new Form { Text = name + " · 사용한도 초기화", Icon = appIcon, ClientSize = new Size(426, 314), StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, Font = new Font("Malgun Gothic", 10), BackColor = Color.White };
        resetCountLabel = new Label { Left = 20, Top = 18, Width = 180, Height = 26 };
        resetCheckedLabel = new Label { Left = 222, Top = 22, Width = 184, Height = 22, Font = new Font("Malgun Gothic", 9), TextAlign = ContentAlignment.TopRight };
        var expiryTitle = new Label { Text = "만료일 · 남은 기간", Left = 20, Top = 57, Width = 386, Height = 24 };
        resetExpiryList = new ListBox { Left = 20, Top = 85, Width = 386, Height = 116, IntegralHeight = false, SelectionMode = SelectionMode.None };
        resetMessageLabel = new Label { Left = 20, Top = 214, Width = 386, Height = 46, Font = new Font("Malgun Gothic", 9) };
        resetUseButton = new Button { Text = "초기화 1회 사용", Left = 20, Top = 268, Width = 146, Height = 32 };
        var refresh = new Button { Text = "새로고침", Left = 176, Top = 268, Width = 108, Height = 32 };
        var close = new Button { Text = "닫기", Left = 294, Top = 268, Width = 112, Height = 32 };
        resetUseButton.Click += delegate { UseReset(index); }; refresh.Click += delegate { Command("usage", null); }; close.Click += delegate { resetDialog.Close(); };
        resetDialog.Controls.AddRange(new Control[] { resetCountLabel, resetCheckedLabel, expiryTitle, resetExpiryList, resetMessageLabel, resetUseButton, refresh, close });
        UpdateResetDialog(Object(Object(Read(Path.Combine(state, "manager-status.json")), "resetCredits"), index == 0 ? "business" : "pro"));
        Command("usage", null);
        var openedDialog = resetDialog;
        try { openedDialog.ShowDialog(window); }
        finally {
            openedDialog.Dispose();
            if (System.Object.ReferenceEquals(resetDialog, openedDialog)) resetDialog = null;
        }
    }
    void UseReset(int index)
    {
        string role = index == 0 ? "business" : "pro", name = index == 0 ? "Business" : "Pro";
        var s = Read(Path.Combine(state, "manager-status.json"));
        var value = Object(Object(s, "resetCredits"), role);
        if (Text(value, "canUse") != "True" || Text(value, "busy") == "True") return;
        bool pending = Text(value, "pending") == "True";
        string question = pending ? name + " 계정의 이전 초기화 요청 결과를 확인합니다.\r\n같은 요청을 다시 확인하며 새로운 초기화권을 추가로 사용하지 않습니다." : name + " 계정의 초기화 1회를 사용하시겠습니까?\r\n남은 횟수: " + Text(value, "availableCount") + "회\r\n" + String.Join("\r\n", ResetExpiryText(value).ToArray()) + "\r\n\r\n만료가 가장 빠른 초기화권 1회가 소모됩니다.";
        if (MessageBox.Show(resetDialog, question, name + " 초기화 확인", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        resetUseButton.Enabled = false;
        var command = new Dictionary<string, object> { { "action", "reset" }, { "role", role }, { "confirmed", true }, { "accountKey", Text(value, "accountKey") } };
        string path = Path.Combine(state, "commands", Guid.NewGuid().ToString() + ".json");
        File.WriteAllText(path + ".tmp", json.Serialize(command), new UTF8Encoding(false)); File.Move(path + ".tmp", path);
    }
    void AddUsageCard(int index, string title, int left)
    {
        var card = new GroupBox { Text = title, Left = left, Top = 58, Width = 308, Height = 188 };
        usageLabels[index] = new Label { Left = 14, Top = 24, Width = 132, Height = 24, Font = new Font("Malgun Gothic", 9) };
        card.Controls.Add(usageLabels[index]);
        for (int row = 0; row < 2; row++) {
            usageWindowLabels[index, row] = new Label { Left = 14, Top = 68 + row * 68, Width = 278, Height = 42, Font = new Font("Malgun Gothic", 9) };
            usageBars[index, row] = new ProgressBar { Left = 14, Top = 111 + row * 68, Width = 278, Height = 12, Maximum = 100 };
            card.Controls.Add(usageWindowLabels[index, row]); card.Controls.Add(usageBars[index, row]);
        }
        resetButtons[index] = new Button { Left = 154, Top = 19, Width = 140, Height = 30, Text = "사용한도 초기화 (…)" , Font = new Font("Malgun Gothic", 9) };
        int selected = index; resetButtons[index].Click += delegate { ShowResetDialog(selected); };
        card.Controls.Add(resetButtons[index]);
        window.Controls.Add(card);
    }
    void ShowStatus()
    {
        if (window != null && !window.IsDisposed) { window.Hide(); window.Show(); window.WindowState = FormWindowState.Normal; window.Activate(); return; }
        window = new Form { Text = "Codex 계정 자동 관리", Icon = appIcon, ClientSize = new Size(664, 431), StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, Font = new Font("Malgun Gothic", 10), BackColor = Color.White };
        statusLabel = new Label { Left = 24, Top = 18, Width = 616, Height = 28 };
        window.Controls.Add(statusLabel);
        AddUsageCard(0, "Business 사용량", 20); AddUsageCard(1, "Pro 사용량", 336);
        metricsLabel = new Label { Left = 24, Top = 264, Width = 616, Height = 110 };
        window.Controls.Add(metricsLabel);
        var autoButton = new Button { Text = "Business 우선", Left = 24, Top = 383, Width = 118, Height = 32 };
        var proButton = new Button { Text = "Pro만 사용", Left = 150, Top = 383, Width = 110, Height = 32 };
        var checkButton = new Button { Text = "연결 재진단", Left = 268, Top = 383, Width = 118, Height = 32 };
        var refreshButton = new Button { Text = "사용량 새로고침", Left = 394, Top = 383, Width = 140, Height = 32 };
        var closeButton = new Button { Text = "닫기", Left = 542, Top = 383, Width = 98, Height = 32 };
        autoButton.Click += delegate { Mode("auto"); }; proButton.Click += delegate { Mode("pro"); };
        checkButton.Click += delegate { Recover(); Command("check", null); }; closeButton.Click += delegate { window.Close(); };
        refreshButton.Click += delegate { Command("usage", null); };
        window.Controls.AddRange(new Control[] { autoButton, proButton, checkButton, refreshButton, closeButton });
        UpdateStatus(Read(Path.Combine(state, "manager-status.json"))); window.Show();
        Command("usage", null);
    }
    void BeginExit()
    {
        exiting = true;
        if (manager != null && !manager.HasExited) {
            Command("quit", null);
            var quitTimer = new System.Windows.Forms.Timer { Interval = 500 };
            DateTime since = DateTime.UtcNow;
            bool waitingNotice = false;
            quitTimer.Tick += delegate {
                if (manager.HasExited) { quitTimer.Stop(); quitTimer.Dispose(); ExitThread(); }
                else if (!waitingNotice && (DateTime.UtcNow - since).TotalSeconds > 20) {
                    waitingNotice = true;
                    Notice("exit-wait", "진행 중인 응답 완료 대기", "응답이 끝난 뒤 중계와 트레이를 종료합니다.");
                }
            };
            quitTimer.Start();
        } else { RestoreConfig(); ExitThread(); }
    }
    protected override void ExitThreadCore()
    {
        timer.Stop(); icon.Visible = false; icon.Dispose();
        if (window != null) window.Dispose();
        if (resetDialog != null) resetDialog.Dispose();
        appIcon.Dispose();
        base.ExitThreadCore();
    }
    [STAThread]
    static void Main(string[] args)
    {
        int attachPid = 0;
        foreach (string arg in args) if (arg.StartsWith("--attach-manager=", StringComparison.Ordinal)) {
            if (!Int32.TryParse(arg.Substring("--attach-manager=".Length), out attachPid) || attachPid <= 0) return;
        }
        string state = Environment.GetEnvironmentVariable("CODEX_RELAY_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex-account-relay");
        // Separate state directories must never target a production instance during isolated tests.
        string identity = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        string stateKey;
        using (var hash = SHA256.Create()) {
            stateKey = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(state).ToUpperInvariant()))).Replace("-", "").Substring(0, 16);
        }
        bool created;
        using (var mutex = new Mutex(true, "Local\\CodexAccountRelay-" + identity + "-" + stateKey, out created)) {
            if (!created) { Directory.CreateDirectory(state); File.WriteAllText(Path.Combine(state, "show-status.request"), "show"); return; }
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new RelayTray(Array.IndexOf(args, "--show") >= 0, attachPid));
        }
    }
}
