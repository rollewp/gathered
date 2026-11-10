'use client'
import { useFormStatus } from 'react-dom'
import { Button } from '@/components/ui/button'

/** Primary form button that disables itself and shows progress text while its form is submitting. */
export function SubmitButton({ children, pendingText, className = '' }: { children: React.ReactNode; pendingText: string; className?: string }) {
  const { pending } = useFormStatus()
  return <Button type="submit" disabled={pending} className={`bg-[#3e644b] hover:bg-[#315239] ${className}`}>{pending ? pendingText : children}</Button>
}
