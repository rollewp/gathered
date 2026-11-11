'use client'

// Member-facing error boundary. Deliberately generic: no stack trace, SQL, provider or prompt text.
export default function MemberError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-2xl px-5 py-16">
        <div role="alert" className="rounded-2xl border border-[#ecd9d4] bg-[#fbf3f1] p-6">
          <p className="font-medium text-[#8a3b2e]">Something went wrong on our side.</p>
          <p className="mt-2 text-sm leading-6 text-[#69736b]">Nothing was changed. Please try again in a moment.</p>
          <button type="button" onClick={reset} className="mt-4 rounded-md border border-[#3e644b] px-4 py-2 text-sm font-medium text-[#3e644b] hover:bg-[#f0f6ee]">Try again</button>
        </div>
      </main>
    </div>
  )
}
