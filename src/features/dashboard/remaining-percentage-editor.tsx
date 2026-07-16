import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface RemainingPercentageEditorProps {
  canEdit: boolean
  isOverridden: boolean
  isSaving: boolean
  onSave: (value: number) => Promise<boolean>
  value: number | null
  windowLabel: string
}

export function RemainingPercentageEditor({
  canEdit,
  isOverridden,
  isSaving,
  onSave,
  value,
  windowLabel,
}: RemainingPercentageEditorProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.select()
    }
  }, [isEditing])

  const parsedValue = Number(draft)
  const isValid =
    draft.trim() !== '' &&
    Number.isInteger(parsedValue) &&
    parsedValue >= 0 &&
    parsedValue <= 100

  async function submit() {
    if (!isValid || isSaving) {
      return
    }

    if (await onSave(parsedValue)) {
      setIsEditing(false)
    }
  }

  if (!isEditing) {
    return (
      <div className="flex items-center gap-1">
        <span className="font-medium text-foreground">
          {value == null ? 'N/A' : `${value}%`}
        </span>
        {isOverridden ? (
          <span className="text-xs text-muted-foreground">manual</span>
        ) : null}
        {canEdit && value != null ? (
          <Button
            aria-label={`Edit ${windowLabel} remaining percentage`}
            className="size-6 text-muted-foreground"
            onClick={() => {
              setDraft(String(value))
              setIsEditing(true)
            }}
            size="icon-xs"
            title={`Edit ${windowLabel} remaining percentage`}
            type="button"
            variant="ghost"
          >
            <Pencil className="size-3" />
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="relative w-16">
        <Input
          aria-label={`${windowLabel} remaining percentage`}
          className="h-7 pr-5"
          disabled={isSaving}
          inputMode="numeric"
          max={100}
          min={0}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setIsEditing(false)
            }
          }}
          ref={inputRef}
          step={1}
          type="number"
          value={draft}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
          %
        </span>
      </div>
      <Button
        aria-label="Save percentage"
        disabled={!isValid || isSaving}
        size="icon-xs"
        title="Save percentage"
        type="submit"
        variant="ghost"
      >
        <Check className="size-3" />
      </Button>
      <Button
        aria-label="Cancel editing"
        disabled={isSaving}
        onClick={() => setIsEditing(false)}
        size="icon-xs"
        title="Cancel editing"
        type="button"
        variant="ghost"
      >
        <X className="size-3" />
      </Button>
    </form>
  )
}
