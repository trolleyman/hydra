# Desktop deep links

Hydra desktop links use the `hydra://` URL scheme to open a specific part of
the native application. They identify Hydra objects; they do not carry server
addresses, filesystem paths, authentication credentials, or commands.

## Supported links

| Link | Opens |
| --- | --- |
| `hydra://settings` | Global settings |
| `hydra://project/<project-id>` | A project |
| `hydra://project/<project-id>/agent/<agent-id>` | An exact agent conversation |
| `hydra://focused/<project-id>` | A new focused chat window for a project |

For example:

```text
hydra://project/hydra
hydra://project/hydra/agent/fix-linux-package
hydra://focused/hydra
hydra://settings
```

`hydra://focused/_chat` opens the built-in chat project. This is also the New
chat action in the Linux desktop entry.

Project and agent IDs may contain ASCII letters, digits, `.`, `_`, and `-`.
They are stable Hydra IDs, not project display names or directory paths.

## Opening a link

On an installed Linux build, open the link through the desktop environment or
pass it to the application directly:

```bash
xdg-open 'hydra://project/hydra/agent/fix-linux-package'
hydra-desktop 'hydra://focused/hydra'
```

The `.deb` registers `hydra-desktop` as the `x-scheme-handler/hydra` handler.
When Hydra is already open, Linux delivers the activation to the existing app
instance, which navigates its active window. Otherwise the link starts the app
and its normal backend discovery/authentication flow.

The URL scheme is currently registered by the Linux package. macOS and Windows
use the same proposed grammar, but their installers must still register and
validate OS activation before links should be advertised as supported there.

## Browser equivalents

The desktop shell maps a link onto the authenticated loopback Hydra server it
discovered. The corresponding web routes are:

| Desktop link | Web route |
| --- | --- |
| `hydra://settings` | `/settings` |
| `hydra://project/<project-id>` | `/project/<project-id>` |
| `hydra://project/<project-id>/agent/<agent-id>` | `/project/<project-id>/agent/<agent-id>` |
| `hydra://focused/<project-id>` | `/focused/<project-id>` |

Callers should use `hydra://` only for native-app activation. Browser links
should use Hydra's ordinary HTTP route on the server already in use.

## Validation and security

Hydra rejects:

- unknown actions or extra path components;
- IDs outside the allowed character set;
- query strings, fragments, or embedded credentials;
- non-`hydra` schemes;
- raw filesystem paths, hosts, ports, and shell commands.

After parsing a link, the desktop shell preserves the private loopback server
origin and one-time bootstrap fragment it obtained through the daemon control
channel. A link therefore cannot redirect the webview, choose another Hydra
server, or supply authentication material.

The grammar is intentionally small. Add a new action in
`internal/desktop.ApplyDeepLink`, cover accepted and rejected forms in
`internal/desktop/desktop_test.go`, and update this document before registering
the action with an OS shell.
