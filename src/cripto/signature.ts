// Isomorphic EIP-712 definitions for a document signature.
//
// This is the cryptographic core of the "advanced electronic signature":
// the signer's wallet signs a well-defined, tamper-evident payload that is
// uniquely linked to the document hash and to the signer. Usable from both the
// browser (to sign, via Privy) and the server (to verify, via ethers).

export interface SignatureMessage {
  documentId: string;
  documentHash: string; // 0x-prefixed sha256 of the file
  signerEmail: string;
  statement: string;
  timestamp: number; // unix seconds, asserted by the signer
}

export const SIGN_STATEMENT =
  "Declaro haber leído y acepto firmar electrónicamente este documento.";

// EIP-712 domain. chainId ties the signature to the target network.
export function signatureDomain(chainId: number) {
  return {
    name: "sygners",
    version: "1",
    chainId,
  };
}

export const SIGNATURE_TYPES: Record<string, { name: string; type: string }[]> = {
  DocumentSignature: [
    { name: "documentId", type: "string" },
    { name: "documentHash", type: "bytes32" },
    { name: "signerEmail", type: "string" },
    { name: "statement", type: "string" },
    { name: "timestamp", type: "uint256" },
  ],
};

export function buildSignatureMessage(params: {
  documentId: string;
  documentHash: string;
  signerEmail: string;
  timestamp: number;
}): SignatureMessage {
  return {
    documentId: params.documentId,
    documentHash: params.documentHash,
    signerEmail: params.signerEmail.trim().toLowerCase(),
    statement: SIGN_STATEMENT,
    timestamp: params.timestamp,
  };
}
