export default function Loading() {
  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-6xl px-5 py-10 lg:px-8 lg:py-16" aria-busy="true">
        <p role="status" className="text-sm text-[#69736b]">Loading groups…</p>
        <div aria-hidden className="mt-6 grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-48 animate-pulse rounded-2xl border border-[#e1e8df] bg-white" />)}
        </div>
      </main>
    </div>
  )
}
