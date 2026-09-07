import React, { type ButtonHTMLAttributes, type ReactNode } from 'react'

export function Button({ className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const variants = {
    primary: 'bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]',
    secondary: 'border border-[var(--vscode-button-border,transparent)] bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]',
    ghost: 'text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]',
    danger: 'text-[var(--vscode-errorForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]',
  }
  return <button className={`inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50 ${variants[variant]} ${className}`} {...props} />
}

export function IconButton({ label, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button aria-label={label} className={`inline-flex size-7 items-center justify-center rounded-md text-[var(--vscode-descriptionForeground)] transition-colors hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)] ${className}`} {...props}>{children}</button>
}

export function PageHeading({ title, detail, actions }: { title: string; detail?: string; actions?: ReactNode }) {
  return <div className="mb-4 flex items-start justify-between gap-3"><div><h1 className="m-0 text-sm font-semibold text-[var(--vscode-foreground)]">{title}</h1>{detail && <p className="mt-1 mb-0 text-xs leading-relaxed text-[var(--vscode-descriptionForeground)]">{detail}</p>}</div>{actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}</div>
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--vscode-foreground)]"><span>{label}</span>{children}{hint && <span className="font-normal leading-relaxed text-[var(--vscode-descriptionForeground)]">{hint}</span>}</label>
}
