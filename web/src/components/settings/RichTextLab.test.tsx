import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RichTextLab } from './RichTextLab'

afterEach(cleanup)

describe('RichTextLab', () => {
  it('mounts the editor instead of waiting on its own editor callback', async () => {
    const view = render(<RichTextLab />)

    await waitFor(() => expect(view.getByRole('textbox', { name: 'Rich text editor demo' })).toBeVisible())
    expect(view.queryByText('Loading rich text editor...')).not.toBeInTheDocument()
  })
})
