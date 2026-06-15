/*
 * Seccomp-BPF filter generator for the claude-sandboxed bwrap wrapper.
 *
 * Builds a default-ALLOW filter that denies (EPERM) a curated set of
 * dangerous, host-affecting syscalls, then dumps the raw BPF program to
 * stdout in the format bubblewrap's `--seccomp FD` expects (an array of
 * `struct sock_filter`, as produced by seccomp_export_bpf()).
 *
 * Philosophy: this is a "devel-friendly" filter modelled on Flatpak's core
 * seccomp blocklist. It intentionally leaves ptrace(2) and perf_event_open(2)
 * ALLOWED so debuggers/profilers (gdb, strace, perf) still work inside the
 * sandbox. It blocks namespace/mount manipulation (which is the primary
 * sandbox-escape vector), the kernel keyring, module (un)loading, and other
 * syscalls a normal coding workload never needs.
 *
 * Scope note: only the NATIVE architecture is filtered. A process could in
 * principle reach a blocked syscall via a secondary ABI (x32/i386), but that
 * is out of scope for the "erratic agent" threat model this sandbox targets.
 *
 * Build: cc -O2 -o seccomp-gen claude-sandbox-seccomp.c -lseccomp
 */

#include <seccomp.h>
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

static const char *const blocked[] = {
    /* Mount / namespace manipulation (sandbox-escape surface) */
    "mount", "umount", "umount2", "pivot_root", "chroot",
    "setns", "unshare",
    /* File-handle reopen can bypass the mount namespace */
    "open_by_handle_at", "name_to_handle_at",
    /* Kernel keyring */
    "add_key", "keyctl", "request_key",
    /* Kernel module (un)loading */
    "init_module", "finit_module", "delete_module",
    /* Kexec — load a new kernel */
    "kexec_load", "kexec_file_load",
    /* Swap management */
    "swapon", "swapoff",
    /* Power / kernel-log / accounting / quota */
    "reboot", "syslog", "acct", "quotactl",
    /* Legacy / rarely-needed and historically abused */
    "uselib", "_sysctl", "modify_ldt", "personality",
    /* eBPF — broad kernel attack surface */
    "bpf",
    NULL,
};

int main(void)
{
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) {
        fprintf(stderr, "seccomp_init failed\n");
        return 1;
    }

    for (const char *const *name = blocked; *name; name++) {
        int nr = seccomp_syscall_resolve_name(*name);
        if (nr == __NR_SCMP_ERROR)
            continue; /* syscall does not exist on this architecture */
        /* Ignore per-rule failures (e.g. duplicate/absent) rather than abort. */
        seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0);
    }

    if (seccomp_export_bpf(ctx, STDOUT_FILENO) < 0) {
        fprintf(stderr, "seccomp_export_bpf failed\n");
        seccomp_release(ctx);
        return 1;
    }

    seccomp_release(ctx);
    return 0;
}
