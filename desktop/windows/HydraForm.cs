using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HydraDesktop;

internal enum HydraWindowKind
{
    Full,
    Focused,
}

internal sealed class HydraForm : Form
{
    private readonly HydraApplicationContext application;
    private bool allowClose;
    private bool activeTurn;

    internal HydraForm(
        HydraWindowKind kind,
        BackendController backend,
        CoreWebView2Environment webViewEnvironment,
        HydraApplicationContext application,
        string? requestedProjectId = null)
    {
        this.application = application;
        Text = kind == HydraWindowKind.Full ? "Hydra" : "Hydra - Focused chat";
        Width = kind == HydraWindowKind.Full ? 1380 : 940;
        Height = kind == HydraWindowKind.Full ? 900 : 780;
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;

        var menu = new MenuStrip();
        var file = new ToolStripMenuItem("&File");
        file.DropDownItems.Add(new ToolStripMenuItem("New Hydra window", null, (_, _) => application.OpenWindow(HydraWindowKind.Full), Keys.Control | Keys.N));
        file.DropDownItems.Add(new ToolStripMenuItem("New focused chat", null, (_, _) => application.OpenWindow(HydraWindowKind.Focused), Keys.Control | Keys.Shift | Keys.N));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(new ToolStripMenuItem("Exit", null, async (_, _) => await application.ExitAsync(), Keys.Alt | Keys.F4));
        menu.Items.Add(file);
        MainMenuStrip = menu;
        Controls.Add(menu);

        var webView = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(webView);
        webView.BringToFront();
        Shown += async (_, _) =>
        {
            await webView.EnsureCoreWebView2Async(webViewEnvironment);
            webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var target) ||
                    target.Host.Equals(backend.BaseUrl!.Host, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                if (target.Scheme is "http" or "https")
                {
                    Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
                }
                args.Cancel = true;
            };
            webView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var target) &&
                    !target.Host.Equals(backend.BaseUrl!.Host, StringComparison.OrdinalIgnoreCase) &&
                    target.Scheme is "http" or "https")
                {
                    Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
                }
                else
                {
                    application.OpenWindow(HydraWindowKind.Full);
                }
                args.Handled = true;
            };
            webView.CoreWebView2.WebMessageReceived += (_, args) =>
            {
                try
                {
                    using var message = JsonDocument.Parse(args.WebMessageAsJson);
                    var root = message.RootElement;
                    if (!root.TryGetProperty("type", out var typeElement)) return;
                    var type = typeElement.GetString();
                    var projectId = root.TryGetProperty("projectId", out var projectElement) ? projectElement.GetString() : null;
                    switch (type)
                    {
                        case "new-full-window":
                            application.OpenWindow(HydraWindowKind.Full);
                            break;
                        case "new-focused-window":
                            application.OpenWindow(HydraWindowKind.Focused, projectId);
                            break;
                        case "active-project" when projectId is not null:
                            application.SetActiveProject(projectId);
                            break;
                        case "window-state":
                            activeTurn = root.TryGetProperty("activeTurn", out var activeElement) && activeElement.GetBoolean();
                            break;
                        case "close-window":
                            Close();
                            break;
                    }
                }
                catch (JsonException)
                {
                    // Ignore malformed/unrecognised page messages. Navigation is
                    // origin-restricted, so only Hydra content reaches this bridge.
                }
            };
            var focusedProject = requestedProjectId ?? backend.Status?.DefaultProjectId;
            var path = kind == HydraWindowKind.Focused && focusedProject is { } project
                ? $"/focused/{Uri.EscapeDataString(project)}"
                : "/";
            var target = new UriBuilder(new Uri(backend.BaseUrl!, path));
            if (backend.TakeBootstrapToken() is { } token)
            {
                target.Fragment = "desktop-bootstrap=" + Uri.EscapeDataString(token);
            }
            webView.Source = target.Uri;
        };
    }

    internal void AllowClose() => allowClose = true;

    protected override void OnFormClosing(FormClosingEventArgs eventArgs)
    {
        if (!allowClose && eventArgs.CloseReason == CloseReason.UserClosing && activeTurn)
        {
            var answer = MessageBox.Show(
                "This agent is still working. Closing the window leaves it running in the background.",
                "Close this window?",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning);
            if (answer != DialogResult.OK)
            {
                eventArgs.Cancel = true;
            }
        }
        if (!allowClose && eventArgs.CloseReason == CloseReason.ApplicationExitCall)
        {
            eventArgs.Cancel = true;
        }
        base.OnFormClosing(eventArgs);
    }
}
