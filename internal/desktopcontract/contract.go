// Package desktopcontract defines the small compatibility boundary shared by
// the Go backend and native desktop shells.
package desktopcontract

// Protocol changes whenever a shell/backend pairing would otherwise appear to
// connect successfully but cannot safely perform its startup contract.
const Protocol = 2
