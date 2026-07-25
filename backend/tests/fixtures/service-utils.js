export async function fetchUserById(apiClient, userId) {
  if (!apiClient || typeof apiClient.get !== "function") {
    throw new Error("A valid apiClient is required");
  }

  if (!userId) {
    throw new Error("User id is required");
  }

  const response = await apiClient.get(`/users/${userId}`);

  if (!response || !response.data) {
    throw new Error("Invalid API response");
  }

  return response.data;
}

export async function saveOrder(orderService, order) {
  if (!orderService || typeof orderService.save !== "function") {
    throw new Error("A valid orderService is required");
  }

  if (!order || !order.id) {
    throw new Error("Order with id is required");
  }

  const saved = await orderService.save(order);

  return {
    success: true,
    order: saved,
  };
}

export async function loginUser(authService, email, password) {
  if (!authService || typeof authService.login !== "function") {
    throw new Error("A valid authService is required");
  }

  if (!email || !password) {
    throw new Error("Email and password are required");
  }

  const result = await authService.login(email, password);

  if (!result || !result.token) {
    throw new Error("Authentication failed");
  }

  return result.token;
}