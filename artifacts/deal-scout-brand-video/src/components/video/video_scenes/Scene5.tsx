import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400),
      setTimeout(() => setPhase(2), 1800),
      setTimeout(() => setPhase(3), 3500),
      setTimeout(() => setPhase(4), 5500),
      setTimeout(() => setPhase(5), 7500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const features = [
    {
      title: "Product Reputation",
      desc: "Brand reliability & model history",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[2.5vw] h-[2.5vw]">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ),
      color: "#F59E0B"
    },
    {
      title: "Smart Negotiation",
      desc: "Ready-to-copy buyer messages",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[2.5vw] h-[2.5vw]">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
      color: "#8B5CF6"
    }
  ];

  return (
    <motion.div
      className="absolute inset-0 flex items-center overflow-hidden"
      initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }}
      animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }}
      exit={{ opacity: 0, clipPath: 'inset(0 0 0 100%)' }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="w-full h-full flex items-center px-[8vw]">
        <div className="w-[50vw] flex flex-col gap-[5vh]">
          <motion.h2
            className="text-[3.5vw] font-bold leading-tight"
            style={{ fontFamily: 'var(--font-display)' }}
            initial={{ opacity: 0, y: 30 }}
            animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
            transition={{ duration: 0.7 }}
          >
            Know What You're Buying
          </motion.h2>

          {features.map((feat, i) => (
            <motion.div
              key={feat.title}
              className="flex items-start gap-6"
              initial={{ opacity: 0, x: -40 }}
              animate={phase >= i + 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -40 }}
              transition={{ type: "spring", stiffness: 200, damping: 20 }}
            >
              <motion.div
                className="w-[5vw] h-[5vw] rounded-2xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${feat.color}20`, border: `2px solid ${feat.color}50` }}
                animate={phase >= i + 2 ? { scale: [0.8, 1.1, 1] } : {}}
                transition={{ duration: 0.5 }}
              >
                <div style={{ color: feat.color }}>{feat.icon}</div>
              </motion.div>
              <div>
                <h3 className="text-[2.2vw] font-bold text-white" style={{ fontFamily: 'var(--font-display)' }}>
                  {feat.title}
                </h3>
                <p className="text-[1.3vw] text-slate-400 mt-1">{feat.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          className="absolute right-[6vw] w-[35vw] h-[50vh]"
          initial={{ opacity: 0, scale: 0.8, rotateY: 15 }}
          animate={phase >= 3 ? { opacity: 1, scale: 1, rotateY: 0 } : { opacity: 0, scale: 0.8, rotateY: 15 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="w-full h-full rounded-2xl bg-slate-800/60 border border-slate-700/50 backdrop-blur-md p-8 flex flex-col gap-6">
            <motion.div
              className="flex items-center gap-3"
              initial={{ opacity: 0 }}
              animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
              transition={{ delay: 0.3 }}
            >
              <div className="w-[2vw] h-[2vw] rounded-full bg-amber-500/30 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" className="w-[1.2vw] h-[1.2vw]">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              </div>
              <span className="text-[1.2vw] text-slate-300 font-medium">Product Reputation</span>
            </motion.div>

            <motion.div
              className="flex-1 rounded-xl bg-slate-900/50 p-6 flex flex-col gap-4"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6 }}
            >
              <div className="flex justify-between items-center">
                <span className="text-[1.1vw] text-slate-400">Brand Reliability</span>
                <div className="flex gap-1">
                  {[1,2,3,4,5].map(s => (
                    <motion.div
                      key={s}
                      className="w-[1.5vw] h-[0.5vw] rounded-full"
                      style={{ backgroundColor: s <= 4 ? '#10B981' : '#334155' }}
                      initial={{ scaleX: 0 }}
                      animate={phase >= 4 ? { scaleX: 1 } : { scaleX: 0 }}
                      transition={{ delay: s * 0.1, duration: 0.3 }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[1.1vw] text-slate-400">Model History</span>
                <span className="text-[1.1vw] text-emerald-400 font-medium">Excellent</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[1.1vw] text-slate-400">Known Issues</span>
                <span className="text-[1.1vw] text-emerald-400 font-medium">None Found</span>
              </div>
            </motion.div>

            <motion.div
              className="rounded-xl bg-purple-500/10 border border-purple-500/30 p-4"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 5 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6 }}
            >
              <p className="text-[0.9vw] text-purple-300 italic leading-relaxed">
                "Hi, I'm interested in your listing. Based on recent sales, similar items sell for $380-$420. Would you consider $390?"
              </p>
              <div className="mt-3 flex items-center gap-2">
                <div className="px-3 py-1 rounded-full bg-purple-500/20 border border-purple-500/40">
                  <span className="text-[0.8vw] text-purple-300 font-medium">Copy Message</span>
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
