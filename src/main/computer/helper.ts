/**
 * The Windows side of computer use, as one PowerShell script.
 *
 * Everything that needs the Win32 API lives here rather than in a native module, so
 * the app still ships with nothing to compile and nothing to rebuild per Electron
 * version. The script is written to a temporary file once per app run and invoked
 * with -File; it reads one JSON request on stdin and prints one JSON reply, so the
 * TypeScript side never builds a command line out of model-supplied text.
 *
 * Input is synthesised with SendInput, not the older mouse_event/SendKeys pair:
 * SendInput is what Windows itself treats as real input, it batches atomically, and
 * KEYEVENTF_UNICODE lets `type` send any character rather than only what a US
 * keyboard layout can reach.
 */

export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Without this the reply is written in the console codepage, and any window title
# with a non-ASCII character comes back as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

public static class Clf {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr lp);

  static int VX { get { return GetSystemMetrics(76); } }
  static int VY { get { return GetSystemMetrics(77); } }
  static int VW { get { return GetSystemMetrics(78); } }
  static int VH { get { return GetSystemMetrics(79); } }

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Exception("SendInput was blocked (sent " + sent + " of " + inputs.Length + "). A window running as administrator can refuse synthetic input.");
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data;
    i.u.mi.dwFlags = flags;
    return i;
  }

  // SendInput takes absolute coordinates normalised to 0..65535 across the whole
  // virtual desktop, not pixels, so every monitor layout works with one formula.
  public static void Move(int x, int y) {
    int nx = (int)(((double)(x - VX) * 65535.0) / Math.Max(1, VW - 1));
    int ny = (int)(((double)(y - VY) * 65535.0) / Math.Max(1, VH - 1));
    Send(new INPUT[] { Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0) });
  }

  static void ButtonFlags(string button, out uint down, out uint up) {
    switch (button) {
      case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
      case "middle": case "wheel": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
      default: down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
    }
  }

  public static void Click(int x, int y, string button, int times) {
    Move(x, y);
    uint down, up;
    ButtonFlags(button, out down, out up);
    List<INPUT> batch = new List<INPUT>();
    for (int n = 0; n < times; n++) {
      batch.Add(Mouse(down, 0, 0, 0));
      batch.Add(Mouse(up, 0, 0, 0));
    }
    Send(batch.ToArray());
  }

  public static void Scroll(int x, int y, int dx, int dy) {
    Move(x, y);
    List<INPUT> batch = new List<INPUT>();
    // Positive scroll_y means "scroll down" for the caller; the wheel API is the
    // other way round, hence the negation.
    if (dy != 0) batch.Add(Mouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(-dy * 120))));
    if (dx != 0) batch.Add(Mouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
    if (batch.Count > 0) Send(batch.ToArray());
  }

  public static void Drag(int[] xs, int[] ys, string button) {
    uint down, up;
    ButtonFlags(button, out down, out up);
    Move(xs[0], ys[0]);
    Send(new INPUT[] { Mouse(down, 0, 0, 0) });
    for (int i = 1; i < xs.Length; i++) { Move(xs[i], ys[i]); System.Threading.Thread.Sleep(12); }
    Send(new INPUT[] { Mouse(up, 0, 0, 0) });
  }

  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return i;
  }

  static INPUT Unicode(char c, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = 0;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }

  /** Types literal text, layout-independently. */
  public static void Type(string text) {
    List<INPUT> batch = new List<INPUT>();
    foreach (char c in text) {
      if (c == '\n') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); continue; }
      if (c == '\r') continue;
      batch.Add(Unicode(c, false));
      batch.Add(Unicode(c, true));
      // SendInput caps out on very long batches; flush in chunks.
      if (batch.Count >= 200) { Send(batch.ToArray()); batch.Clear(); }
    }
    if (batch.Count > 0) Send(batch.ToArray());
  }

  /**
   * Presses keys together, holds the chord briefly, then releases in reverse.
   * Sending down+up for an entire chord as one zero-delay batch is accepted by
   * SendInput but some Windows apps miss system shortcuts such as ALT+F4. Keeping
   * the modifiers physically down for a few milliseconds makes the sequence match
   * a real keyboard much more closely without making ordinary shortcuts feel slow.
   */
  public static void Press(ushort[] vks) {
    List<INPUT> down = new List<INPUT>();
    List<INPUT> up = new List<INPUT>();
    for (int i = 0; i < vks.Length; i++) down.Add(Key(vks[i], false));
    for (int i = vks.Length - 1; i >= 0; i--) up.Add(Key(vks[i], true));
    Send(down.ToArray());
    System.Threading.Thread.Sleep(35);
    Send(up.ToArray());
  }

  public static string Cursor() {
    POINT p; GetCursorPos(out p);
    return p.X + "," + p.Y;
  }

  /** Virtual desktop rect, then the primary monitor's size. */
  public static string Screen() {
    return VX + "," + VY + "," + VW + "," + VH + "," + GetSystemMetrics(0) + "," + GetSystemMetrics(1);
  }

  public static string Rect(long handle) {
    RECT r;
    if (!GetWindowRect(new IntPtr(handle), out r)) throw new Exception("No window with that id is open.");
    return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
  }

  public static List<string> Windows() {
    List<string> found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLengthW(h);
      if (len == 0) return true;
      // WS_EX_TOOLWINDOW: palettes and other chrome the user never thinks of as
      // a window, which would otherwise bury the real ones.
      if ((GetWindowLong(h, -20) & 0x00000080) != 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      RECT r; GetWindowRect(h, out r);
      if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
      found.Add(string.Join(((char)31).ToString(), new string[] {
        h.ToInt64().ToString(), sb.ToString(), proc,
        r.Left.ToString(), r.Top.ToString(), (r.Right - r.Left).ToString(), (r.Bottom - r.Top).ToString(),
        IsIconic(h) ? "minimized" : (h == GetForegroundWindow() ? "foreground" : "open")
      }));
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /**
   * Windows refuses SetForegroundWindow to a process that does not own the current
   * foreground window. Briefly attaching to that window's input thread is the
   * long-standing way to be allowed to do it.
   */
  public static bool Focus(long handle) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    if (IsIconic(h)) ShowWindow(h, 9);
    uint dummy;
    uint target = GetWindowThreadProcessId(h, out dummy);
    uint fore = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint self = GetCurrentThreadId();
    if (fore != self) AttachThreadInput(fore, self, true);
    bool ok = SetForegroundWindow(h);
    if (fore != self) AttachThreadInput(fore, self, false);
    return ok;
  }

  public static long ForegroundId() {
    return GetForegroundWindow().ToInt64();
  }

  /**
   * Grabs a screen region and saves it as a PNG no wider than maxW.
   *
   * The scaling happens here rather than after the fact because a 4K PNG is slow to
   * write, slow to read back and slow to base64, and nothing downstream ever wants
   * one. Returns the size actually written.
   */
  public static string Capture(int x, int y, int w, int h, int maxW, string file) {
    int outW = w, outH = h;
    if (maxW > 0 && w > maxW) {
      outW = maxW;
      outH = (int)Math.Round((double)h * maxW / w);
      if (outH < 1) outH = 1;
    }
    using (Bitmap shot = new Bitmap(w, h))
    using (Graphics g = Graphics.FromImage(shot)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      if (outW == w && outH == h) {
        shot.Save(file, System.Drawing.Imaging.ImageFormat.Png);
      } else {
        using (Bitmap small = new Bitmap(outW, outH))
        using (Graphics gs = Graphics.FromImage(small)) {
          gs.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          gs.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
          gs.DrawImage(shot, new Rectangle(0, 0, outW, outH));
          small.Save(file, System.Drawing.Imaging.ImageFormat.Png);
        }
      }
    }
    return outW + "," + outH;
  }
}
'@ -ReferencedAssemblies System.Drawing

# Requests arrive as one JSON object per stdin line. The process stays alive, so the
# expensive Add-Type/C# compilation above happens once instead of on every MCP call.
# Model-supplied text is data parsed by ConvertFrom-Json and is never evaluated as
# PowerShell source.

function Vk([string]$name) {
  $n = $name.ToUpperInvariant()
  $map = @{
    'CTRL'=0x11; 'CONTROL'=0x11; 'ALT'=0x12; 'SHIFT'=0x10; 'WIN'=0x5B; 'SUPER'=0x5B; 'CMD'=0x5B;
    'ENTER'=0x0D; 'RETURN'=0x0D; 'TAB'=0x09; 'ESC'=0x1B; 'ESCAPE'=0x1B; 'SPACE'=0x20;
    'BACKSPACE'=0x08; 'DELETE'=0x2E; 'DEL'=0x2E; 'INSERT'=0x2D; 'HOME'=0x24; 'END'=0x23;
    'PAGEUP'=0x21; 'PAGEDOWN'=0x22; 'UP'=0x26; 'DOWN'=0x28; 'LEFT'=0x25; 'RIGHT'=0x27;
    'F1'=0x70;'F2'=0x71;'F3'=0x72;'F4'=0x73;'F5'=0x74;'F6'=0x75;
    'F7'=0x76;'F8'=0x77;'F9'=0x78;'F10'=0x79;'F11'=0x7A;'F12'=0x7B;
    'PRINTSCREEN'=0x2C; 'CAPSLOCK'=0x14
  }
  if ($map.ContainsKey($n)) { return [uint16]$map[$n] }
  if ($n.Length -eq 1) {
    $c = [char]$n
    if (($c -ge 'A' -and $c -le 'Z') -or ($c -ge '0' -and $c -le '9')) { return [uint16][int][char]$c }
  }
  throw "BAD_KEY: Unknown key: $name"
}

function Get-WindowRows {
  $rows = @()
  foreach ($line in [Clf]::Windows()) {
    $f = $line -split ([char]31)
    $rows += @{
      id = [int64]$f[0]; title = $f[1]; process = $f[2]
      x = [int]$f[3]; y = [int]$f[4]; width = [int]$f[5]; height = [int]$f[6]; state = $f[7]
    }
  }
  return $rows
}

function Get-ScreenRect {
  $s = [Clf]::Screen() -split ','
  return @{
    virtual = @{ x = [int]$s[0]; y = [int]$s[1]; width = [int]$s[2]; height = [int]$s[3] }
    primary = @{ x = 0; y = 0; width = [int]$s[4]; height = [int]$s[5] }
  }
}

function Assert-Focused([int64]$id) {
  [Clf]::Focus($id) | Out-Null
  Start-Sleep -Milliseconds 120
  $foreground = [Clf]::ForegroundId()
  if ($foreground -ne $id) {
    throw "FOCUS_FAILED: requested $id but foreground is $foreground"
  }
}

function Find-UiElements($request) {
  $id = if ($request.id) { [int64]$request.id } else { [Clf]::ForegroundId() }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$id)
  } catch {
    throw "UIA_FAILED: no accessible window with id $id"
  }
  if ($null -eq $root) { throw "UIA_FAILED: no accessible window with id $id" }

  $query = ([string]$request.query).Trim().ToLowerInvariant()
  $role = ([string]$request.role).Trim().ToLowerInvariant()
  $limit = if ($request.maxResults) { [Math]::Min(100, [Math]::Max(1, [int]$request.maxResults)) } else { 30 }
  $found = @()
  try {
    $all = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    for ($i = 0; $i -lt $all.Count -and $found.Count -lt $limit; $i++) {
      try {
        $current = $all.Item($i).Current
        $name = [string]$current.Name
        $automationId = [string]$current.AutomationId
        $control = [string]$current.ControlType.ProgrammaticName
        if ($control.StartsWith('ControlType.')) { $control = $control.Substring(12) }
        if ($query -and -not ($name.ToLowerInvariant().Contains($query) -or $automationId.ToLowerInvariant().Contains($query))) { continue }
        if ($role -and -not $control.ToLowerInvariant().Contains($role)) { continue }
        $r = $current.BoundingRectangle
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }
        $found += @{
          name = $name
          role = $control
          automationId = $automationId
          enabled = [bool]$current.IsEnabled
          offscreen = [bool]$current.IsOffscreen
          bounds = @{
            x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y)
            width = [int][Math]::Round($r.Width); height = [int][Math]::Round($r.Height)
          }
        }
      } catch { }
    }
  } catch {
    throw "UIA_FAILED: $($_.Exception.Message)"
  }
  return @{ window = $id; elements = @($found) }
}

function Handle-Request($request) {
  $result = @{ ok = $true }
  switch ($request.op) {
    'windows' {
      $screen = Get-ScreenRect
      $result.windows = @(Get-WindowRows)
      $result.screen = $screen.virtual
    }
    'active' {
      $screen = Get-ScreenRect
      $foreground = [Clf]::ForegroundId()
      $result.window = @((Get-WindowRows) | Where-Object { $_.id -eq $foreground } | Select-Object -First 1)[0]
      $result.screen = $screen.virtual
    }
    'find_ui' {
      $ui = Find-UiElements $request
      $result.window = $ui.window
      $result.elements = @($ui.elements)
    }
    'capture' {
      $screen = Get-ScreenRect
      if ($request.region) {
        $x = [int]$request.region.x; $y = [int]$request.region.y
        $w = [int]$request.region.width; $h = [int]$request.region.height
      } elseif ($request.id) {
        $id = [int64]$request.id
        Assert-Focused $id
        $r = [Clf]::Rect($id) -split ','
        $x = [int]$r[0]; $y = [int]$r[1]; $w = [int]$r[2]; $h = [int]$r[3]
      } elseif ($request.full) {
        $x = [int]$screen.virtual.x; $y = [int]$screen.virtual.y
        $w = [int]$screen.virtual.width; $h = [int]$screen.virtual.height
      } else {
        $x = 0; $y = 0; $w = [int]$screen.primary.width; $h = [int]$screen.primary.height
      }
      if ($w -le 0 -or $h -le 0) { throw "CAPTURE_FAILED: target has no drawable area" }
      $maxW = 0
      if ($request.maxWidth) { $maxW = [int]$request.maxWidth }
      $out = [Clf]::Capture($x, $y, $w, $h, $maxW, $request.file) -split ','
      $result.region = @{ x = $x; y = $y; width = $w; height = $h }
      $result.image = @{ width = [int]$out[0]; height = [int]$out[1] }
      $result.screen = $screen.virtual
    }
    'focus' {
      $id = [int64]$request.id
      [Clf]::Focus($id) | Out-Null
      Start-Sleep -Milliseconds 120
      $result.foreground = [Clf]::ForegroundId()
      $result.focused = ($result.foreground -eq $id)
    }
    'act' {
      foreach ($a in $request.actions) {
        switch ($a.type) {
          'move'         { [Clf]::Move([int]$a.x, [int]$a.y) }
          'click'        { [Clf]::Click([int]$a.x, [int]$a.y, $a.button, 1) }
          'double_click' { [Clf]::Click([int]$a.x, [int]$a.y, $a.button, 2) }
          'scroll'       { [Clf]::Scroll([int]$a.x, [int]$a.y, [int]$a.scroll_x, [int]$a.scroll_y) }
          'drag'         { [Clf]::Drag([int[]]$a.xs, [int[]]$a.ys, $a.button) }
          'type'         { [Clf]::Type([string]$a.text) }
          'keypress'     { [Clf]::Press([uint16[]]@($a.keys | ForEach-Object { Vk $_ })) }
          'focus'        { Assert-Focused ([int64]$a.window) }
          'wait'         { Start-Sleep -Milliseconds ([int]$a.ms) }
          default        { throw "BAD_ACTION: Unknown action: $($a.type)" }
        }
        Start-Sleep -Milliseconds 20
      }
      $cursor = [Clf]::Cursor() -split ','
      $result.cursor = @{ x = [int]$cursor[0]; y = [int]$cursor[1] }
      $result.foreground = [Clf]::ForegroundId()
    }
    default { throw "BAD_REQUEST: Unknown op: $($request.op)" }
  }
  return $result
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $request = $line | ConvertFrom-Json
    $reply = Handle-Request $request
  } catch {
    $message = $_.Exception.Message
    $code = 'HELPER_ERROR'
    if ($message -match '^([A-Z0-9_]+):\s*(.+)') {
      $code = $Matches[1]
      $message = $Matches[2]
    }
    $reply = @{ ok = $false; error_code = $code; message = $message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
`;
