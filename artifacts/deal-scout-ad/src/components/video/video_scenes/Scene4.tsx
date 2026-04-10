import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600),
      setTimeout(() => setPhase(2), 1200),
      setTimeout(() => setPhase(3), 2000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex items-center justify-center flex-col"
      initial={{ scale: 1.2, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.8, opacity: 0 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="text-center z-10 w-full px-12 relative">
        
        {/* Giant Warning Background Text */}
        <motion.div 
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-0"
          initial={{ opacity: 0 }}
          animate={phase >= 1 ? { opacity: 0.05 } : { opacity: 0 }}
        >
          <div className="text-[20vw] font-black text-error leading-none whitespace-nowrap uppercase italic mix-blend-screen">
            SCAM DETECTED
          </div>
        </motion.div>

        <motion.div
          className="relative z-10 bg-bg-light/90 backdrop-blur-xl border-2 border-error/50 rounded-3xl p-10 max-w-3xl mx-auto shadow-[0_0_100px_rgba(255,51,102,0.2)]"
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 25, delay: 0.2 }}
        >
          <div className="flex items-center justify-center gap-4 mb-6">
            <motion.div 
              className="w-16 h-16 rounded-full bg-error flex items-center justify-center"
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </motion.div>
            <h2 className="text-5xl font-black text-white uppercase tracking-tight">Security Check</h2>
          </div>

          <div className="space-y-4 text-left">
            {[
              { text: "Regex pattern match: Suspicious links", done: phase >= 1 },
              { text: "Claude AI: Condition description mismatch", done: phase >= 2 },
              { text: "Risk assessment: Extremely high", done: phase >= 3 }
            ].map((item, i) => (
              <motion.div 
                key={i}
                className="flex items-center gap-4 bg-bg-dark/80 p-4 rounded-xl border border-error/20"
                initial={{ opacity: 0, x: -20 }}
                animate={item.done ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${item.done ? 'bg-error text-white' : 'bg-bg-light text-white/30'}`}>
                  {item.done ? '×' : ''}
                </div>
                <span className={`text-xl font-bold font-mono ${item.done ? 'text-error' : 'text-white/30'}`}>
                  {item.text}
                </span>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
