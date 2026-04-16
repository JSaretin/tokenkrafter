<script lang="ts">
	import { page } from '$app/state';
  import { ethers } from 'ethers';
  import { getContext, onMount } from 'svelte';

    let getProvider:(()=> (ethers.BrowserProvider | null)) = getContext('provider')
    let getSigner:(()=> (ethers.Signer | null)) = getContext('signer')
    let getUserAddress:(()=> (string | null)) = getContext('userAddress')

    let provider = $derived(getProvider())
    let signer = $derived(getSigner())
    let userAddress = $derived(getUserAddress())



  let tokenInfo: {
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: number
  } = $state({
    decimals: 0,
    name: '',
    symbol: '',
    totalSupply: 0
  })

  const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');

  const supportedNetworks: {name: string; symbol: string; chain_id: number; usdt_address: string, platform_address: string}[] = [
    {
      chain_id: 1,
      name: "Ethereum",
      symbol: "ETH",
      usdt_address: '0x4e9ce36e442e55ecd9025b9a6e0d88485d628a67',
      platform_address: '0x'
    },
    {
      chain_id: 56,
      name: "Binance Smart Chain",
      symbol: "BSC", 
      usdt_address: '0x55d398326f99059ff775485246999027b3197955',
      platform_address: '0x6ec1002522358265C0147C155BED87369639dfB5'
    }
  ]

  const PLATFORM_ABI = [
    'function createToken(string name, string symbol, uint256 totalSupply, uint8 decimals) returns (address)',
    'function getCreationFee() external view returns (uint256)',
    'function getCreatedTokens(address creator) external view returns (address[])'
  ];

   const IERC20 = [
     'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  ];




  onMount(async () => {
    if (!provider) return
    const connectedChain = ethers.toNumber((await provider.getNetwork()).chainId)
    const network = supportedNetworks.find((n)=>n.chain_id == connectedChain)

    if (!network) {
        console.log('unsupported network')
        return
    }

    const contract = new ethers.Contract(page.params.contract_addr!, IERC20, provider)
    tokenInfo = {
        decimals: ethers.toNumber(await contract.decimals()),
        name: await contract.name(),
        symbol: await contract.symbol(),
        totalSupply: Number(ethers.formatEther(await contract.totalSupply())),
    }
  });


  let showPreview = $state(false)

  function displayReview(){
    showPreview = true;
  }
</script>


<h1>address: {userAddress}</h1>

<div class="mt-20">
    <h2>Token Info</h2>

    <div class="">
        <div class="">Contract <span>{page.params.contract_addr}</span></div>
        <div class="">Name <span>{tokenInfo.name}</span></div>
        <div class="">Symbol <span>{tokenInfo.symbol}</span></div>
        <div class="">Decimals <span>{tokenInfo.decimals}</span></div>
        <div class="">Total Supply <span>{tokenInfo.totalSupply.toLocaleString()}</span></div>
    </div>
</div>