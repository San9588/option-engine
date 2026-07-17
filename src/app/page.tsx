import { db } from "@/db";
import { sql } from "drizzle-orm";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await db.execute(sql`select 1`);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-6">
      <section className="w-full max-w-2xl rounded-3xl bg-slate-800/50 backdrop-blur p-10 shadow-2xl border border-slate-700">
        <p className="m-0 text-sm uppercase tracking-[0.15em] text-cyan-400 font-semibold">
          Trading Platform
        </p>
        <h1 className="mt-4 text-[clamp(2rem,5vw,3.25rem)] font-bold leading-[1.05] text-white">
          Option Chain <span className="text-cyan-400">Engine</span>
        </h1>
        <p className="mt-4 text-base text-slate-300">
          Real-time option chain data with WebSocket streaming, professional trading UI, 
          and SQLite persistence.
        </p>
        
        <div className="mt-8 flex flex-wrap gap-4">
          <Link
            href="/option-chain"
            className="inline-flex items-center gap-2 px-6 py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-all hover:scale-105 shadow-lg shadow-cyan-500/25"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Open Option Chain
          </Link>
          
          <a
            href="/api/health"
            target="_blank"
            className="inline-flex items-center gap-2 px-6 py-3 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-xl transition-all"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Health Check
          </a>
        </div>

        <div className="mt-10 p-4 bg-slate-900/50 rounded-xl border border-slate-700">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Features</h3>
          <ul className="grid grid-cols-2 gap-2 text-sm text-slate-300">
            <li className="flex items-center gap-2">
              <span className="text-cyan-400">✓</span> Real-time WebSocket
            </li>
            <li className="flex items-center gap-2">
              <span className="text-cyan-400">✓</span> Multiple Symbols
            </li>
            <li className="flex items-center gap-2">
              <span className="text-cyan-400">✓</span> ATM Auto-Center
            </li>
            <li className="flex items-center gap-2">
              <span className="text-cyan-400">✓</span> Column Settings
            </li>
            <li className="flex items-center gap-2">
              <span className="text-cyan-400">✓</span> Rank Highlighting
            </li>
            <li className="flex items-center gap-2">
              <span className="text-cyan-400">✓</span> SQLite Persistence
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
