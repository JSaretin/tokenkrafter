import { ethers } from 'ethers';


interface TokenInfo {
    address: string,
    name: string,
    symbol: string,
    decimals: number,
    image: {
        thumb: string;
        large: string;
        small: string;
    }
    image_url: string,
    websites: string[],
    discord_url: string | null,
    telegram_handle: string | null,
    twitter_handle: string | null,
    description: string,
    
}

const TOKEN_FACTORY_ABI = [
	'function createToken(string name, string symbol, uint256 totalSupply, uint8 decimals, uint8 tokenType, address paymentToken, address referral) external payable returns (address)',
	'function creationFee(uint8 tokenType) view returns (uint256)',
	'function convertFee(uint256 feeUsdt, address paymentToken) view returns (uint256)',
	'function totalTokensCreated() view returns (uint256)',
	'function owner() view returns (address)',
	'function withdrawFees(address token) external',
];



const gctBase = "https://api.geckoterminal.com/api/v2"


async function getter(path: string){
    const req = await fetch(`${gctBase}${path}`, {
        method: "GET",
        headers: {
            "Accept": "application/json;version=20230203"
        }
    })
    return (await req.json())
}
async function main(){
   
    const res: {
        relationships: {
            base_token: {
                data: {
                    id: string
                }
            }
        }
    }[] = await getter("/networks/bsc/trending_pools").then(i=>i.data)
   
    const contracts = res.map(i=>i.relationships.base_token.data.id.split("_")[1])
    // console.log(contracts)

    for (const contract of contracts) {
        const {data: {attributes: tokenInfo}}: {data: {attributes: TokenInfo}}= (await getter(`/networks/bsc/tokens/${contract}/info`))

        const {address, name, symbol, decimals, image_url, websites, discord_url, telegram_handle, twitter_handle, description} = tokenInfo

        console.log(`Token: ${name} (${symbol})`)
        console.log(`Address: ${address}`)
        console.log(`Decimals: ${decimals}`)
        console.log(`Image URL: ${image_url}`)
        console.log(`Websites: ${websites.join(", ")}`)
        console.log(`Discord: ${discord_url || "N/A"}`)
        console.log(`Telegram: ${telegram_handle || "N/A"}`)
        console.log(`Twitter: ${twitter_handle || "N/A"}`)
        console.log(`Description: ${description}`)
        console.log("=".repeat(50))
        break
    }

    
}

main().then(()=>{}).catch(()=>{})