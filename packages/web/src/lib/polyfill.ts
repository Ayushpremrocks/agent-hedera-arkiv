// The Hedera SDK and WalletConnect expect Node's Buffer; browsers don't have it.
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
