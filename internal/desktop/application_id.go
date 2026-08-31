package desktop

const (
	// linuxApplicationID matches the installed Freedesktop desktop-entry basename.
	linuxApplicationID = "org.trolleyman.hydra"
	// linuxDevelopmentApplicationID keeps Mage launches separate from an installed
	// Hydra application and its desktop integration.
	linuxDevelopmentApplicationID = linuxApplicationID + ".Devel"
)

// LinuxApplicationID returns the Freedesktop identity for the current launch.
// GTK exposes it as the Wayland application ID and derives the X11 WM class
// from it, allowing the desktop environment to associate windows with the
// matching installed icon.
func LinuxApplicationID() string {
	if CurrentLaunchConfig().Build == "development" {
		return linuxDevelopmentApplicationID
	}
	return linuxApplicationID
}
