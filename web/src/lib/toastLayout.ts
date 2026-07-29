// One width for the notification column.
//
// Every card in the bottom-right stack used to size itself: the plain toast to
// its content (17-22rem), the approval card to a fixed 28rem. Right-aligned in
// one column that reads as a pile of unrelated things - the left edge steps in
// and out card by card, so the icon tiles never line up and nothing looks like
// it belongs to the same channel. Pinning them to one width makes it a column.
//
// 26rem is the meet-in-the-middle: wider than the old plain toast (an agent
// title is a whole human phrase and was truncating), and near enough the
// approval card's old 28rem to keep the reason it was wide in the first place -
// an approval is READ, not glanced at, and a command or URL that wraps over
// fewer lines is fewer places for something nasty to hide.
//
// The compact scale (lib/copyToast's "Copied X" acknowledgement) deliberately
// keeps its own narrower box: it is a glance-and-gone ack rather than something
// you stop and read, and two words in a 26rem card is the mostly-empty card the
// compact scale exists to avoid.
export const TOAST_CARD_WIDTH = 'w-[26rem] max-w-[calc(100vw-2rem)]'
