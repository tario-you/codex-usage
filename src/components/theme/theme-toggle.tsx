import { Laptop, Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { useTheme, type ThemePreference } from './theme'

const themeOptions: Array<{
  icon: typeof Sun
  label: string
  value: ThemePreference
}> = [
  {
    icon: Sun,
    label: 'Light',
    value: 'light',
  },
  {
    icon: Moon,
    label: 'Dark',
    value: 'dark',
  },
  {
    icon: Laptop,
    label: 'System',
    value: 'system',
  },
]

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()

  return (
    <div
      aria-label="Color theme"
      className={cn(
        'grid grid-cols-3 gap-1 rounded-lg border border-border bg-background p-1 sm:inline-flex sm:w-auto',
        className,
      )}
      role="group"
    >
      {themeOptions.map(({ icon: Icon, label, value }) => (
        <Button
          aria-label={label}
          aria-pressed={theme === value}
          className="h-8 justify-center rounded-md px-3"
          key={value}
          onClick={() => setTheme(value)}
          title={label}
          type="button"
          variant={theme === value ? 'secondary' : 'ghost'}
        >
          <Icon className="size-3.5" />
        </Button>
      ))}
    </div>
  )
}
