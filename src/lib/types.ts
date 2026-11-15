import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";

export type CartView = NonNullable<FunctionReturnType<typeof api.carts.mine>>;
export type CartItem = CartView["items"][number];
export type ItemDetail = NonNullable<FunctionReturnType<typeof api.items.get>>;
