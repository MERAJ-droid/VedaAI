'use client';

import { useState } from 'react';
import Image from 'next/image';
import { ChevronsRight, X } from 'lucide-react';

const NAV_ITEMS = [
  { label: 'Home',         icon: '/assets/home icon.png' },
  { label: 'My Classroom', icon: '/assets/my classroom icon.png' },
  { label: 'Assignments',  icon: '/assets/assignments icon.png' },
  { label: 'Exams',        icon: '/assets/exams icon.png' },
  { label: 'My Library',   icon: '/assets/my library icon.png' },
];

interface SidebarProps {
  activeItem?: string;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({ activeItem = 'Exams', isMobileOpen = false, onMobileClose }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const sidebarContent = (isMobile: boolean) => (
    <div className="flex flex-col h-full">
      {/* ── Logo row ───────────────────────────────────────────────────────── */}
      <div className={`flex items-center mb-6 ${!isMobile && collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Image src="/assets/veda ai logo.png" alt="VedaAI" width={34} height={34} className="shrink-0" />
          {(!collapsed || isMobile) && (
            <span className="font-extrabold text-gray-900 text-lg tracking-tight whitespace-nowrap">VedaAI</span>
          )}
        </div>
        {/* Toggle / Close button */}
        {isMobile ? (
          <button
            onClick={onMobileClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors shrink-0"
            aria-label="Close sidebar"
          >
            <X className="w-5 h-5" />
          </button>
        ) : (
          !collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className="p-1 rounded hover:bg-gray-100 transition-colors shrink-0"
              aria-label="Collapse sidebar"
            >
              <Image src="/assets/side bar icon.png" alt="Collapse" width={18} height={18} />
            </button>
          )
        )}
      </div>

      {/* ── AI Teacher's Toolkit ────────────────────────────────────────────── */}
      <div className={`mb-6 ${!isMobile && collapsed ? 'px-2' : 'px-3'}`}>
        {!isMobile && collapsed ? (
          /* Collapsed: icon-only dark circle with gradient ring */
          <div className="flex justify-center">
            <div
              className="p-[1.5px] rounded-full"
              style={{ background: 'linear-gradient(180deg, #FF7950 0%, #C0350A 100%)' }}
            >
              <button className="w-9 h-9 rounded-full bg-gray-900 flex items-center justify-center hover:bg-gray-800 transition-colors">
                <Image
                  src="/assets/ai teacher's toolkit icon.png"
                  alt="AI Teacher's Toolkit"
                  width={16}
                  height={16}
                  className="brightness-0 invert"
                />
              </button>
            </div>
          </div>
        ) : (
          /* Expanded: full labelled pill */
          <div
            className="p-[1.5px] rounded-full"
            style={{ background: 'linear-gradient(180deg, #FF7950 0%, #C0350A 100%)' }}
          >
            <button className="flex items-center gap-2 w-full rounded-full bg-gray-900 text-white text-sm font-bold px-4 py-2.5 hover:bg-gray-800 transition-colors">
              <Image
                src="/assets/ai teacher's toolkit icon.png"
                alt=""
                width={16}
                height={16}
                className="brightness-0 invert"
              />
              AI Teacher&apos;s Toolkit
            </button>
          </div>
        )}
      </div>

      {/* ── Nav items ───────────────────────────────────────────────────────── */}
      <nav className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const isActive = item.label === activeItem;
          return (
            <button
              key={item.label}
              onClick={isMobile ? onMobileClose : undefined}
              className={`flex items-center w-full rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                !isMobile && collapsed ? 'justify-center px-0' : 'gap-3 px-3'
              } ${
                isActive
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
              }`}
            >
              <Image
                src={item.icon}
                alt={item.label}
                width={18}
                height={18}
                className={isActive ? '' : 'opacity-60'}
              />
              {(!collapsed || isMobile) && item.label}
            </button>
          );
        })}
      </nav>

      {/* ── Bottom section ──────────────────────────────────────────────────── */}
      <div className="pt-2 border-t border-gray-100 mt-2 px-2 space-y-1">
        {/* Settings — hidden when collapsed on desktop */}
        {(!collapsed || isMobile) && (
          <button className="flex items-center gap-3 w-full rounded-lg px-3 py-2.5 text-sm font-semibold text-gray-500 hover:bg-gray-50 hover:text-gray-800 transition-colors">
            <Image src="/assets/settings icon.png" alt="Settings" width={18} height={18} className="opacity-60" />
            Settings
          </button>
        )}

        {/* School badge */}
        <div className={`flex items-center py-1.5 ${!isMobile && collapsed ? 'justify-center' : 'gap-3 px-1'}`}>
          <Image
            src="/assets/dps icon.png"
            alt="School"
            width={34}
            height={34}
            className="rounded-full shrink-0"
          />
          {(!collapsed || isMobile) && (
            <div className="min-w-0">
              <p className="text-sm font-extrabold text-gray-900 truncate">Delhi Public School</p>
              <p className="text-xs font-medium text-gray-400 truncate">Bokaro Steel City</p>
            </div>
          )}
        </div>

        {/* Expand button — only shown when collapsed on desktop */}
        {!isMobile && collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="flex items-center justify-center w-full py-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <ChevronsRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar (hidden on mobile) */}
      <aside
        className={`hidden md:flex shrink-0 flex-col bg-white rounded-2xl m-3 py-5 transition-all duration-200 ease-in-out overflow-hidden ${
          collapsed ? 'w-[72px]' : 'w-60'
        }`}
        style={{ boxShadow: '0 4px 32px 0 rgba(0,0,0,0.13)' }}
      >
        {sidebarContent(false)}
      </aside>

      {/* Mobile Drawer (visible only when isMobileOpen is true, slides in from right side) */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 flex justify-end md:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
            onClick={onMobileClose}
          />
          {/* Drawer content */}
          <div
            className="relative flex flex-col w-[280px] max-w-[85vw] h-full bg-white p-4 shadow-2xl z-10 animate-in slide-in-from-right duration-200"
          >
            {sidebarContent(true)}
          </div>
        </div>
      )}
    </>
  );
}


