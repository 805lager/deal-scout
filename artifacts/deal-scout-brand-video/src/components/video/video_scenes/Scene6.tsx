import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import demoScreenshot from "@assets/Screenshot_2026-04-10_143449_1775857180037.png";

export function Scene6() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1200),
      setTimeout(() => setPhase(3), 2500),
      setTimeout(() => setPhase(4), 5500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const platforms = ["Facebook Marketplace", "Craigslist", "eBay", "OfferUp"];

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="absolute top-[6vh] text-center z-20"
        initial={{ opacity: 0, y: -30 }}
        animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: -30 }}
        transition={{ duration: 0.6 }}
      >
        <h2 className="text-[3vw] font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          See It In Action
        </h2>
        <div className="flex gap-6 mt-4 justify-center">
          {platforms.map((p, i) => (
            <motion.span
              key={p}
              className="text-[1vw] text-slate-400 px-4 py-2 rounded-full border border-slate-700/50 bg-slate-800/50"
              initial={{ opacity: 0, y: 10 }}
              animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
              transition={{ delay: i * 0.1, duration: 0.4 }}
            >
              {p}
            </motion.span>
          ))}
        </div>
      </motion.div>

      <motion.div
        className="relative mt-[6vh]"
        initial={{ opacity: 0, y: 40, scale: 0.85 }}
        animate={phase >= 2 ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 40, scale: 0.85 }}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="relative w-[70vw] h-[58vh] rounded-2xl overflow-hidden border-2 border-emerald-500/30 shadow-[0_0_80px_rgba(16,185,129,0.15),0_20px_60px_rgba(0,0,0,0.5)]">
          <img
            src={demoScreenshot}
            className="w-full h-full object-cover object-center"
            alt="Deal Scout in action on Facebook Marketplace"
          />

          <motion.div
            className="absolute inset-0 bg-gradient-to-t from-slate-950/40 via-transparent to-transparent pointer-events-none"
            initial={{ opacity: 0 }}
            animate={phase >= 2 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 1 }}
          />

          <div className="absolute inset-0 pointer-events-none rounded-2xl border border-white/5" />
        </div>

        <motion.div
          className="absolute -bottom-[1vh] left-1/2 -translate-x-1/2 flex items-center gap-3 z-20"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
        >
          <motion.div
            className="px-6 py-3 rounded-full bg-emerald-500/20 border border-emerald-500/40 backdrop-blur-sm"
            animate={phase >= 3 ? { scale: [1, 1.03, 1] } : {}}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          >
            <span className="text-[1.2vw] text-emerald-300 font-medium">Scores in 8-12 seconds</span>
          </motion.div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
