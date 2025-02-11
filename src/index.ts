import { ConfigurationParameters, createJupiterApiClient, QuoteGetRequest } from "@jup-ag/api";
import { ArbBot, SwapToken } from "./bot";
import { clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
require('dotenv').config();

// const ENDPOINT = process.env.JUPITER_ENDPOINT;
// const CONFIG: ConfigurationParameters = {
//     basePath: ENDPOINT
// }
// const jupiterApi = createJupiterApiClient(CONFIG);

// jupiterApi.quoteGet({
//     inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
//     outputMint: "So11111111111111111111111111111111111111112",
//     amount: 210_000_000
// }).then((quote)=> {
//     console.log(quote.outAmount, quote.outputMint);
// }).catch((error)=>console.error(error))


const defaultConfig = {
    solanaEndpoint: clusterApiUrl("mainnet-beta"),
    jupiter: "https://public.jupiterapi.com",
};


async function main() {
    if (!process.env.SECRET_KEY){
        throw new Error("SECRET_KEY enviroment variable not sent ")
    }

    let decodedSecretKey = Uint8Array.from(JSON.parse(process.env.SECRET_KEY))

    const bot = new ArbBot({
        solanaEndpoint: process.env.SOLANA_MAINNET ?? defaultConfig.solanaEndpoint,
        jupiterEndpoint: process.env.JUPITER_ENDPOINT ?? defaultConfig.jupiter,
        secretKey: decodedSecretKey,
        firstTradePrice: 0.1 * LAMPORTS_PER_SOL,
        tragetGainPercentage: 0.15,
        initialInputToken: SwapToken.USDC,
        initialInputAmount: 10_000_000
    })
    await bot.init();
}
main().catch(console.error)