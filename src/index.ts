import { ConfigurationParameters, createJupiterApiClient } from "@jup-ag/api";
require('dotenv').config();

const ENDPOINT = process.env.JUPITER_ENDPOINT;
const CONFIG: ConfigurationParameters = {
    basePath: ENDPOINT
}
const jupiterApi = createJupiterApiClient(CONFIG);

jupiterApi.quoteGet({
    inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    outputMint: "So11111111111111111111111111111111111111112",
    amount: 210_000_000
}).then((quote)=> {
    console.log(quote.outAmount, quote.outputMint);
}).catch((error)=>console.error(error))
