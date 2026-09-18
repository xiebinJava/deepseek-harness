import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PmsOpenAction.module.css'

export type PmsOpenActionProps = PropsRuntime<'conversation.session.header.utilities'> & {
  open: () => void
}

export function PmsOpenAction({ open }: PmsOpenActionProps): ReactNode {
  return (
    <button
      type="button"
      className={css.button}
      onClick={open}
      title="打开 PMS 业务工作区"
      aria-label="打开 PMS 业务工作区"
      data-pms-open
    >
      <IconBrowseOutline16 size={15} />
      <span>PMS</span>
    </button>
  )
}
