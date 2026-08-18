import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/analyze") {
    return NextResponse.rewrite(new URL("/api/analyze-v2", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/analyze",
};
