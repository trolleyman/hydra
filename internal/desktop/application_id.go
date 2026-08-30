package desktop

// linuxApplicationID matches the installed Freedesktop desktop-entry basename.
// GTK exposes it as the Wayland application ID and derives the X11 WM class
// from it, allowing the desktop environment to associate windows with Hydra's
// installed icon.
const linuxApplicationID = "org.trolleyman.hydra"
