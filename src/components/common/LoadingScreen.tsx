
export function LoadingScreen() {
    return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
            <div className="relative">
                {/* Layered Pulse Effect */}
                <div className="absolute inset-0 animate-ping opacity-20 bg-primary rounded-full blur-xl" />
                <div className="absolute inset-0 animate-pulse opacity-40 bg-primary rounded-full blur-md" />

                <div className="relative bg-card p-4 rounded-3xl border shadow-2xl flex items-center justify-center">
                    <img
                        src="/logo.png"
                        alt="Logo"
                        className="h-12 w-12 object-contain animate-bob"
                    />
                </div>
            </div>

            <div className="mt-8 text-center space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-1000">
                <h2 className="text-xl font-black tracking-tight text-foreground uppercase italic">
                    Initializing <span className="text-primary">AIO</span>Manager
                </h2>
                <div className="flex items-center justify-center gap-1.5 pt-1">
                    <div className="w-1 h-1 rounded-full bg-primary animate-bounce [animation-delay:-0.3s]" />
                    <div className="w-1 h-1 rounded-full bg-primary animate-bounce [animation-delay:-0.15s]" />
                    <div className="w-1 h-1 rounded-full bg-primary animate-bounce" />
                </div>
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em] opacity-50">
                    Preparing secure workspace
                </p>
            </div>
        </div>
    )
}
