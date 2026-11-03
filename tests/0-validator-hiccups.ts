// SPDX-License-Identifier: BUSL-1.1
//
// A local validator on a busy machine (seen in WSL) sometimes stalls for several seconds. A
// transaction signed with a fresh blockhash can then fail its preflight with "Blockhash not found"
// although nothing is wrong with it, and the tests after it fail as a knock-on. A transaction that
// fails preflight is never forwarded, so sending the same signed transaction again a moment later
// is safe. This file makes the Connection that Anchor uses retry that one error, up to ten times a
// second apart (five tries half a second apart were not always enough in WSL).
// It loads before the other test files (the name sorts first) and changes nothing else.
import * as anchor from "@coral-xyz/anchor";

const proto = Object.getPrototypeOf(anchor.AnchorProvider.env().connection);
const sendRawTransaction = proto.sendRawTransaction;

proto.sendRawTransaction = async function (this: unknown, ...args: unknown[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendRawTransaction.apply(this, args);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      if (attempt >= 10 || !message.includes("Blockhash not found")) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};
