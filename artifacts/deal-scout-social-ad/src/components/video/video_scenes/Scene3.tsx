import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1500),
      setTimeout(() => setPhase(4), 2500),
      setTimeout(() => setPhase(5), 3500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const features = [
    { label: 'Scam Detection', color: '#EF4444', icon: 'M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    { label: 'Price Comparison', color: '#3B82F6', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6m6 0h6m0 0v-6a2 2 0 012-2h2a2 2 0 012 2v6m-6 0H9' },
    { label: 'Negotiation Help', color: '#8B5CF6', icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  ];

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }}
      animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }}
      exit={{ opacity: 0, clipPath: 'inset(0 0 0 100%)' }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex flex-col items-center gap-[4vh]">
        <motion.h2
          className="text-[3.5vw] font-black text-white tracking-tight"
          style={{ fontFamily: 'var(--font-display)' }}
          initial={{ opacity: 0, y: 30 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.5 }}
        >
          3 Layers of Protection
        </motion.h2>

        <div className="flex gap-[3vw]">
          {features.map((feat, i) => (
            <motion.div
              key={feat.label}
              className="flex flex-col items-center gap-4 p-6 rounded-2xl border backdrop-blur-md w-[20vw]"
              style={{
                backgroundColor: `${feat.color}08`,
                borderColor: `${feat.color}30`
              }}
              initial={{ opacity: 0, y: 50, scale: 0.8 }}
              animate={phase >= i + 2 ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 50, scale: 0.8 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            >
              <motion.div
                className="w-[4vw] h-[4vw] rounded-full flex items-center justify-center"
                style={{ backgroundColor: `${feat.color}20` }}
                animate={phase >= i + 2 ? { scale: [0.8, 1.15, 1] } : {}}
                transition={{ duration: 0.5 }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke={feat.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[2vw] h-[2vw]">
                  <path d={feat.icon} />
                </svg>
              </motion.div>
              <span className="text-[1.3vw] font-bold text-white text-center" style={{ fontFamily: 'var(--font-display)' }}>
                {feat.label}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
