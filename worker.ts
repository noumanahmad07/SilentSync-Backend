// Simple Cloudflare Worker for user settings
// Mock implementation to get the endpoint working

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    try {
      const url = new URL(request.url);
      const method = request.method;
      const path = url.pathname;

      // Log all requests for debugging
      console.log(`[${new Date().toISOString()}] ${method} ${path}`);
      console.log(`Headers:`, Object.fromEntries(request.headers.entries()));

      // Handle CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      // Handle GET /api/user/settings - Mock implementation
      if (method === "GET" && path === "/api/user/settings") {
        const authHeader = request.headers.get("Authorization");

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Unauthorized: Missing token" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        // Mock response - return empty settings for now
        return new Response(
          JSON.stringify({
            success: true,
            uniqueId: null,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // Handle POST /api/user/settings - Mock implementation
      if (method === "POST" && path === "/api/user/settings") {
        const authHeader = request.headers.get("Authorization");

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Unauthorized: Missing token" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        try {
          const body = await request.json();
          const { uniqueId } = body;

          if (!uniqueId || typeof uniqueId !== "string") {
            return new Response(
              JSON.stringify({
                error: "uniqueId is required and must be a string",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          // Mock successful save
          return new Response(
            JSON.stringify({
              success: true,
              message: "Unique ID saved successfully",
              uniqueId: uniqueId.trim(),
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        } catch (error: any) {
          return new Response(
            JSON.stringify({
              error: "Failed to save user settings",
              message: "Invalid JSON body",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      // Handle DELETE /api/delete-account - Mock implementation
      if (method === "DELETE" && path === "/api/delete-account") {
        const authHeader = request.headers.get("Authorization");

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Unauthorized: Missing token" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        // Mock successful deletion
        return new Response(
          JSON.stringify({
            success: true,
            message: "Account and all associated data deleted successfully",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // Handle GET /api/devices - Mock implementation
      if (method === "GET" && path.startsWith("/api/devices")) {
        const authHeader = request.headers.get("Authorization");

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Unauthorized: Missing token" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        // Mock response - return empty devices list for now
        return new Response(
          JSON.stringify({
            success: true,
            devices: [],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // Handle GET /api/user-apk/{identifier} - Mock implementation
      if (method === "GET" && path.startsWith("/api/user-apk/")) {
        const authHeader = request.headers.get("Authorization");

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Unauthorized: Missing token" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        // Extract identifier from path
        const identifier = path.split("/api/user-apk/")[1];

        // Mock response - return no APK for now
        return new Response(
          JSON.stringify({
            success: true,
            hasApk: false,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // Handle health check
      if (path === "/health") {
        return new Response(
          JSON.stringify({
            status: "healthy",
            timestamp: new Date().toISOString(),
            environment: "cloudflare-worker",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // 404 for unknown endpoints
      return new Response(
        JSON.stringify({ error: "Endpoint not found", path }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } catch (error: any) {
      console.error("Cloudflare Worker error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  },
};
