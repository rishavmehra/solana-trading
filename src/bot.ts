import { AccountMeta, createJupiterApiClient, DefaultApi, Instruction, QuoteGetRequest, QuoteResponse, ResponseError } from "@jup-ag/api";
import { AddressLookupTableAccount, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SignatureStatus, TransactionConfirmationStatus, TransactionInstruction, TransactionMessage, TransactionSignature, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from 'fs';
import * as path from 'path';

interface ArbBotConfig {
    solanaEndpoint: string;
    jupiterEndpoint: string;
    secretKey: Uint8Array;
    firstTradePrice: number;
    tragetGainPercentage?: number;
    checkInterval?: number;
    initialInputToken: SwapToken;
    initialInputAmount: number;
}

export enum SwapToken {
    USDC,
    SOL
}

interface NextTrade extends QuoteGetRequest{
    nextTradeThreshold: number;
}

interface LogSwapArgs {
    inputToken: string;
    inAmount: string;
    outputToken: string;
    outAmount: string;
    txId: string;
    timeStamp: string;
}



export class ArbBot {
    private solanaConnection: Connection;
    private jupiterApi: DefaultApi;
    private wallet: Keypair; // we can fetch the sol token balance from here
    private usdcMint: PublicKey = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    private solMint: PublicKey = new PublicKey("So11111111111111111111111111111111111111112");
    private usdcTokenAccount: PublicKey;
    private usdcBalance: number = 0;
    private solBalance: number = 0;
    private priceWatchIntervalId?: NodeJS.Timeout;
    private nextTrade: NextTrade // Need Fix herer
    private waitingForConfirmation: boolean = false;
    private lastCheck: number = 0;
    private checkInterval: number = 1000 * 10;
    private targetGainPercentage: number = 1;

    constructor(config: ArbBotConfig) {
        const {
            solanaEndpoint, 
            jupiterEndpoint, 
            secretKey, 
            firstTradePrice,
            tragetGainPercentage,
            checkInterval, 
            initialInputToken,
            initialInputAmount,
        } = config
        this.solanaConnection = new Connection(solanaEndpoint);
        this.jupiterApi = createJupiterApiClient({basePath: jupiterEndpoint});
        this.wallet = Keypair.fromSecretKey(secretKey);
        this.usdcTokenAccount = getAssociatedTokenAddressSync(this.usdcMint, this.wallet.publicKey);
        if (tragetGainPercentage) {
            this.targetGainPercentage=tragetGainPercentage
        }

        if(checkInterval) {
            this.checkInterval = checkInterval
        }
        this.nextTrade ={
            inputMint: initialInputToken === SwapToken.SOL ? this.solMint.toBase58() : this.usdcMint.toBase58(),
            outputMint: initialInputToken === SwapToken.USDC ? this.usdcMint.toBase58() : this.solMint.toBase58(),
            amount: initialInputAmount,
            nextTradeThreshold: firstTradePrice 
        };
    }

    async init(): Promise<void> {
        console.log(`Initiating arb bot for wallet: ${this.wallet.publicKey.toBase58()}`);
        await this.refreshBalances();
        console.log(`Current Balances: \nSOL: ${this.solBalance / LAMPORTS_PER_SOL}, \nUSDC: ${this.usdcBalance}`);
    }

    private async refreshBalances(): Promise<void> {
        try {
            const results = await Promise.allSettled([
                this.solanaConnection.getBalance(this.wallet.publicKey),
                this.solanaConnection.getTokenAccountBalance(this.usdcTokenAccount)
            ]);

            const solBalanceResult = results[0];
            const usdcBalanceResult = results[1];

            if (solBalanceResult.status === 'fulfilled') {
                this.solBalance = solBalanceResult.value;
            } else {
                console.error(`Error fetching SOL balance: ${solBalanceResult.reason}`);
            }

            if (usdcBalanceResult.status === 'fulfilled') {
                this.usdcBalance = usdcBalanceResult.value.value.uiAmount ?? 0;
            } else {
                this.usdcBalance = 0;
                console.error(`Error fetching USDC Balance: `, usdcBalanceResult.reason);
            }

            if (this.solBalance < LAMPORTS_PER_SOL / 100) {
                this.terminateSession("Low Sol Balance")
            }
        } catch (error) {
            console.error(`Unexpected error during balance refersh: `, error);
        }
    }

    private initiatePriceWatch(): void {
        this.priceWatchIntervalId = setInterval(async () => {
            const currentTime = Date.now();
            if (currentTime - this.lastCheck >= this.checkInterval) {
                this.lastCheck = currentTime;
                try {
                    if (this.waitingForConfirmation) {
                        console.log(`Waiting for previous transaction to confirm...`);
                        return;
                    }
                    const quote = await this.getQuote(this.nextTrade);
                    this.evaluateQuoteAndSwap(quote);
                } catch (error) {
                    console.error(`Error getting quote: `, error)
                }
            }
        }, this.checkInterval)
    }

    private async getQuote(quoteRequest: QuoteGetRequest): Promise<QuoteResponse> {
        try {
            const quote: QuoteResponse | null = await this.jupiterApi.quoteGet(quoteRequest);
            if (!quote) {
                throw new Error('No Quote Found')
            }
            return quote
        } catch (error) {
            if (error instanceof ResponseError) {
                console.log(await error.response.json());
            }
            else {
                console.error(error);
            }
            throw new Error("Unable for find quote");
        }
    }

    private async evaluateQuoteAndSwap(quote: QuoteResponse): Promise<void> {
        let difference = (parseInt(quote.outAmount) - this.nextTrade.nextTradeThreshold) / this.nextTrade.nextTradeThreshold;
        console.log(`Current Price: ${quote.outAmount} is ${difference > 0 ? 'higher' : 'lower'} than the next threshold: ${this.nextTrade.nextTradeThreshold}`);
        if (parseInt(quote.outAmount) > this.nextTrade.nextTradeThreshold) {
            try {
                this.waitingForConfirmation = true;
                await this.executeSwap(quote);
            } catch (error) {
                console.error(`Error executing the swap: ${error}`)
            }
        }
    }

    private async confirmTransaction(
        Connection: Connection,
        signature: TransactionSignature,
        desiredConfirmationStatus: TransactionConfirmationStatus = 'confirmed',
        timeout: number = 3000,
        pollInterval: number = 1000,
        searchTransactionHistory: boolean = false,
    ): Promise<SignatureStatus> {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const { value: statuses } = await Connection.getSignatureStatuses([signature], { searchTransactionHistory });
            if (!statuses || statuses.length === 0) {
                throw new Error('Failed to get signature status')
            }

            const status = statuses[0];

            if (status === null) {
                await new Promise(resolve => setTimeout(resolve, pollInterval))
            }

            if (status?.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`)
            }

            if (status?.confirmationStatus && status.confirmationStatus === desiredConfirmationStatus) {
                return status
            }

            if (status?.confirmationStatus === 'finalized') {
                return status;
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
        throw new Error(` Transaction confirmation timeout after ${timeout}ms`);
    }

    private async executeSwap(route: QuoteResponse): Promise<void> {
        try {
            const {
                computeBudgetInstructions,
                setupInstructions,
                swapInstruction,
                cleanupInstruction,
                addressLookupTableAddresses,
            } = await this.jupiterApi.swapInstructionsPost({
                swapRequest: {
                    quoteResponse: route,
                    userPublicKey: this.wallet.publicKey.toBase58(),
                    prioritizationFeeLamports: 'auto',
                },
            });
            const instructions: TransactionInstruction[] = [
                ...computeBudgetInstructions.map(this.instructionDataToTransactionIntruction),
                ...setupInstructions.map(this.instructionDataToTransactionIntruction),
                this.instructionDataToTransactionIntruction(swapInstruction),
                this.instructionDataToTransactionIntruction(cleanupInstruction)
            ].filter((ix)=> ix !== null) as TransactionInstruction[];

            const addressLookupTableAccounts = await this.getAddressLookupTableAccounts(
                addressLookupTableAddresses,
                this.solanaConnection
            );

            const { blockhash, lastValidBlockHeight } = await this.solanaConnection.getLatestBlockhash();
            const messageV0 = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions
            }).compileToV0Message(addressLookupTableAccounts);

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([this.wallet]);
            
            const rawTransaction = transaction.serialize();
            const txId = await this.solanaConnection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 2
            })

            const confirmation = await this.confirmTransaction(this.solanaConnection, txId);
            if(confirmation.err){
                throw new Error('Transaction Failed')
            }
            await this.postTransactionProcessing(route, txId);
        } catch (error) {
            if (error instanceof ResponseError){
                console.log(await error.response.json());
            } else {
                console.error(error)
            }
            throw new Error("Unable to Execute the Swap")
        } finally {
            this.waitingForConfirmation = false
        }
    }

    private instructionDataToTransactionIntruction(
        instruction: Instruction | undefined
    ) {
        if (instruction === null || instruction === undefined) return null;
        return new TransactionInstruction({
            programId: new PublicKey(instruction.programId),
            keys: instruction.accounts.map((key: AccountMeta) => ({
                pubkey: new PublicKey(key.pubkey),
                isSigner: key.isSigner,
                isWritable: key.isWritable
            })),
            data: Buffer.from(instruction.data, 'base64'),
        });
    };

    private async getAddressLookupTableAccounts(
        keys: string[], connection: Connection
    ): Promise<AddressLookupTableAccount[]> {
        const addressLookupTableAccountInfos = await connection.getMultipleAccountsInfo(
            keys.map((key) => new PublicKey(key))
        );

        return addressLookupTableAccountInfos.reduce((acc, accountInfo, index)=>{
            const addressLookupTableAddress = keys[index];
            if(accountInfo) {
                const addressLookupTableAccount = new AddressLookupTableAccount({
                    key: new PublicKey(addressLookupTableAddress),
                    state: AddressLookupTableAccount.deserialize(accountInfo.data)
                });
                acc.push(addressLookupTableAccount)
            }
            return acc;
        }, new Array<AddressLookupTableAccount>());
    }

    private async postTransactionProcessing(quote: QuoteResponse, txid: string): Promise<void>{
        const { inputMint,  inAmount, outputMint, outAmount } = quote;
        await this.updateNextTrade(quote);
        await this.refreshBalances();
        await this.logSwap({
            inputToken: inputMint,
            inAmount: inAmount,
            outputToken: outputMint,
            outAmount: outAmount,
            txId: txid,
            timeStamp: new Date().toISOString(),
            
        })
    }

    private async logSwap(args: LogSwapArgs): Promise<void>{
        const {
            inputToken,
            inAmount,
            outputToken,
            outAmount,
            txId,
            timeStamp,
        } = args
        
        const logEntry = {
            inputToken,
            inAmount,
            outputToken,
            outAmount,
            txId,
            timeStamp,
        }

        const filePath = path.join(__dirname, 'trades.json');

        try{
            if(!fs.existsSync(filePath)){
                fs.writeFileSync(filePath, JSON.stringify([logEntry], null, 2), 'utf-8');
            } else {
                const data = fs.readFileSync(filePath, { encoding: 'utf-8' });
                const trades = JSON.parse(data);
                trades.push(logEntry);
                fs.writeFileSync(filePath, JSON.stringify(trades, null, 2), 'utf-8');
            }
            console.log(`Logged swap: ${inAmount} ${inputToken} -> ${outAmount} ${outputToken}, \n TX: ${txId} `);
        } catch (error) {
            console.error('Error Logging Swap: ', error);
        }
    }

    private terminateSession(reason: string): void {
        console.warn(`Terminating bot... ${reason}`);
        console.log(`Current balances: \nSOL: ${this.solBalance / LAMPORTS_PER_SOL} \nUSDC: ${this.usdcBalance}`);
        if (this.priceWatchIntervalId) {
            clearInterval(this.priceWatchIntervalId);
            this.priceWatchIntervalId = undefined
        }
        setTimeout(() => {
            console.log(`Bot has terminated`);
            process.exit(1);
        }, 1000)
    }

    private async updateNextTrade(lastTrade: QuoteResponse): Promise<void> {
        const priceChange = this.targetGainPercentage/ 100;
        this.nextTrade = {
            inputMint: this.nextTrade.inputMint,
            outputMint: this.nextTrade.outputMint,
            amount: parseInt(lastTrade.outAmount),
            nextTradeThreshold: parseInt(lastTrade.inAmount) * (1 + priceChange)
        }

    }
}

