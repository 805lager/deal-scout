import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

export function Scene3() {
  const [phase, setPhase] = useState(0);
  const scoreRef = useRef<HTMLDivElement>(null);
  const askingRef = useRef<HTMLSpanElement>(null);
  const marketRef = useRef<HTMLSpanElement>(null);
  const scoreCounter = useRef({ value: 0 });

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 1600),
      setTimeout(() => setPhase(3), 2400),
      setTimeout(() => setPhase(4), 3200),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  useEffect(() => {
    if (phase < 2) return;
    const tl = gsap.timeline();
    tl.to(scoreCounter.current, {
      value: 9.0,
      duration: 1.4,
      ease: 'power3.out',
      onUpdate: () => {
        if (scoreRef.current) {
          scoreRef.current.textContent = scoreCounter.current.value.toFixed(1);
        }
      }
    });
    return () => { tl.kill(); };
  }, [phase]);

  useEffect(() => {
    if (phase < 3 || !askingRef.current) return;
    const obj = { v: 0 };
    const tw = gsap.to(obj, {
      v: 450,
      duration: 0.8,
      ease: 'power2.out',
      onUpdate: () => {
        if (askingRef.current) askingRef.current.textContent = `$${Math.round(obj.v)}`;
      }
    });
    return () => { tw.kill(); };
  }, [phase]);

  useEffect(() => {
    if (phase < 4 || !marketRef.current) return;
    const obj = { v: 0 };
    const tw = gsap.to(obj, {
      v: 599,
      duration: 0.8,
      ease: 'power2.out',
      onUpdate: () => {
        if (marketRef.current) marketRef.current.textContent = `$${Math.round(obj.v)}`;
      }
    });
    return () => { tw.kill(); };
  }, [phase]);

  return (
    <motion.div className="absolute inset-0 flex items-center justify-between px-[10vw]"
      initial={{ x: '100%' }}
      animate={{ x: '0%' }}
      exit={{ x: '-100%' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-1/2 relative z-10 pr-12">
        <motion.h2 
          className="text-[5vw] font-black leading-none text-white mb-6"
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          The Deal Score.
        </motion.h2>
        <motion.p 
          className="text-2xl text-white/60 font-body leading-relaxed"
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6, delay: 0.6 }}
        >
          AI-powered assessment combining price analysis, market comps, and seller reputation. Know exactly what it's worth.
        </motion.p>
      </div>

      <div className="w-1/2 relative z-10 flex justify-center">
        {/* Deal Score UI Mockup */}
        <motion.div 
          className="w-full max-w-md bg-bg-light border border-white/10 rounded-3xl p-8 shadow-2xl relative overflow-hidden"
          initial={{ opacity: 0, scale: 0.8, rotateY: 20 }}
          animate={{ opacity: 1, scale: 1, rotateY: 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20, delay: 0.8 }}
          style={{ transformPerspective: 1000 }}
        >
          {/* Score Circle */}
          <div className="flex justify-center mb-8">
            <div className="relative w-48 h-48 rounded-full border-4 border-bg-dark flex items-center justify-center">
              <motion.svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
                <motion.circle 
                  cx="50" cy="50" r="46" 
                  fill="none" 
                  stroke="var(--color-success)" 
                  strokeWidth="8"
                  strokeDasharray="289"
                  initial={{ strokeDashoffset: 289 }}
                  animate={phase >= 2 ? { strokeDashoffset: 28.9 } : { strokeDashoffset: 289 }}
                  transition={{ duration: 1.5, ease: "easeOut" }}
                />
              </motion.svg>
              <div className="text-center">
                <motion.div 
                  ref={scoreRef}
                  className="text-6xl font-black text-success font-display"
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={phase >= 2 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.5 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.5 }}
                >
                  0.0
                </motion.div>
                <div className="text-white/50 font-bold uppercase tracking-wider text-sm mt-1">Excellent</div>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="space-y-4">
            <motion.div 
              className="flex justify-between items-center bg-bg-dark/50 p-4 rounded-xl"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.4 }}
            >
              <span className="text-white/60 font-bold">Asking Price</span>
              <span ref={askingRef} className="text-white font-bold font-mono text-xl">$0</span>
            </motion.div>
            
            <motion.div 
              className="flex justify-between items-center bg-bg-dark/50 p-4 rounded-xl"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.4 }}
            >
              <span className="text-white/60 font-bold">Market Value</span>
              <span ref={marketRef} className="text-success font-bold font-mono text-xl">$0</span>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
