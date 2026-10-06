# Property Query Parser: Validation Results

Free-text queries run through the parser with the real city list (979 cities from `rets_property`).

| # | Query | Expected filters | Result |
|---|---|---|---|
| 1 | Find me mobile homes in Victorville | city=Victorville, types=ManufacturedHome/ManufacturedOnLand/MobileHome | Pass |
| 2 | Show me 3-bedroom condos in Irvine under $1.5M with a pool | city=Irvine, maxPrice=1500000, beds=3, types=Condominium, pool=true | Pass |
| 3 | 2 bed 2 bath under 800k in San Diego | city=San Diego, maxPrice=800000, beds=2, baths=2 | Pass |
| 4 | townhouse in Temecula with 2.5 baths | city=Temecula, baths=2.5, types=Townhouse | Pass |
| 5 | homes in Oakland between $600k and $900k | city=Oakland, minPrice=600000, maxPrice=900000 | Pass |
| 6 | condos in Palm Springs with HOA under $500 | city=Palm Springs, types=Condominium, maxHoa=500 | Pass |
| 7 | condos in Long Beach with no HOA | city=Long Beach, types=Condominium, maxHoa=0 | Pass |
| 8 | houses in Indio with no pool | city=Indio, types=SingleFamilyResidence, pool=false | Pass |
| 9 | multi-family in Lancaster under $700k | city=Lancaster, maxPrice=700000, types=Duplex/Triplex/Quadruplex | Pass |
| 10 | land in Palmdale | city=Palmdale, warnings=Land and lots are not available in this dataset (residential listings only). | Pass |
| 11 | at least 1,800 sq ft in Murrieta | city=Murrieta, sqft=1800 | Pass |
| 12 | 3 BED CONDO in irvine UNDER $750,000 | city=Irvine, maxPrice=750000, beds=3, types=Condominium | Pass |
| 13 | 2 bed condo under 500k | maxPrice=500000, beds=2, types=Condominium | Pass |

**13 of 13 passed.**
