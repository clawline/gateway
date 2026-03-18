import { useHandleSignInCallback } from '@logto/react';
import { useNavigate } from 'react-router-dom';

export function CallbackPage() {
  const navigate = useNavigate();
  const { isLoading, error } = useHandleSignInCallback(() => {
    navigate('/', { replace: true });
  });

  if (error) {
    return (
      <div className="min-h-screen bg-[#020617] text-rose-400 font-mono flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <p className="text-xs tracking-widest text-rose-600">AUTH_CALLBACK_ERROR</p>
          <p className="text-sm">{error.message}</p>
          <button
            onClick={() => navigate('/', { replace: true })}
            className="px-4 py-2 border border-cyan-800 text-cyan-500 text-xs hover:bg-cyan-950/50 transition-colors"
          >
            RETURN_HOME
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#020617] text-cyan-500 font-mono flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs tracking-widest">PROCESSING_AUTH_CALLBACK...</p>
        </div>
      </div>
    );
  }

  return null;
}
